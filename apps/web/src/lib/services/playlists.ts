import 'server-only';

/**
 * Playlist CRUD (docs/FEATURES.md).
 *
 * Ownership rule: every mutation checks `ownerId === userId` inside the query
 * itself (`where: { id, ownerId }`), so a forged id can never touch another
 * user's playlist. Track counts are denormalised and updated in the same
 * transaction as the track mutation.
 */
import {
  ConflictError,
  LIMITS,
  NotFoundError,
  nonEmptyString,
  parseOrThrow,
  z,
} from '@discord-music/shared';
import { isUniqueConstraintError, MusicSource, type Playlist } from '@discord-music/database';

import { getDb } from '@/lib/db';
import { omitUndefined } from '@/lib/object';

/* ----------------------------------------------------------------- schemas */

export const createPlaylistSchema = z.object({
  name: nonEmptyString(LIMITS.PLAYLIST_NAME_MAX_LENGTH, 'Playlist name'),
  description: z.string().trim().max(LIMITS.PLAYLIST_DESCRIPTION_MAX_LENGTH).optional(),
});

export const updatePlaylistSchema = z
  .object({
    name: nonEmptyString(LIMITS.PLAYLIST_NAME_MAX_LENGTH, 'Playlist name').optional(),
    description: z
      .string()
      .trim()
      .max(LIMITS.PLAYLIST_DESCRIPTION_MAX_LENGTH)
      .nullable()
      .optional(),
    visibility: z.enum(['PRIVATE', 'UNLISTED', 'PUBLIC']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change.');

export const addTrackSchema = z.object({
  encoded: z.string().min(1).max(4096),
  identifier: nonEmptyString(200, 'Identifier'),
  title: nonEmptyString(300, 'Title'),
  author: nonEmptyString(200, 'Author'),
  durationMs: z.number().int().min(0),
  uri: z.url().max(1000).nullable().optional(),
  artworkUrl: z.url().max(1000).nullable().optional(),
  source: z.enum(['youtube', 'spotify', 'soundcloud', 'deezer']),
});

const SOURCE_TO_DB = {
  youtube: MusicSource.YOUTUBE,
  spotify: MusicSource.SPOTIFY,
  soundcloud: MusicSource.SOUNDCLOUD,
  deezer: MusicSource.DEEZER,
} as const;

/* ---------------------------------------------------------------- queries */

export async function listPlaylists(userId: string) {
  return getDb().playlist.findMany({
    where: { ownerId: userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      visibility: true,
      trackCount: true,
      playCount: true,
      updatedAt: true,
    },
  });
}

export async function getPlaylist(userId: string, playlistId: string) {
  const playlist = await getDb().playlist.findFirst({
    where: { id: playlistId, ownerId: userId },
    include: { tracks: { orderBy: { position: 'asc' } } },
  });
  if (playlist === null) {
    throw new NotFoundError('Playlist not found.');
  }
  return playlist;
}

/* -------------------------------------------------------------- mutations */

export async function createPlaylist(userId: string, input: unknown): Promise<Playlist> {
  const data = parseOrThrow(createPlaylistSchema, input);
  const db = getDb();

  const count = await db.playlist.count({ where: { ownerId: userId } });
  if (count >= LIMITS.PLAYLIST_MAX_PER_USER) {
    throw new ConflictError(
      `You have reached the limit of ${String(LIMITS.PLAYLIST_MAX_PER_USER)} playlists.`,
    );
  }

  try {
    return await db.playlist.create({
      data: { ownerId: userId, name: data.name, description: data.description ?? null },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError(`You already have a playlist called “${data.name}”.`);
    }
    throw error;
  }
}

export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: unknown,
): Promise<Playlist> {
  const data = omitUndefined(parseOrThrow(updatePlaylistSchema, input));
  const db = getDb();

  const { count } = await db.playlist.updateMany({
    where: { id: playlistId, ownerId: userId },
    data,
  });
  if (count === 0) throw new NotFoundError('Playlist not found.');

  return db.playlist.findUniqueOrThrow({ where: { id: playlistId } });
}

export async function deletePlaylist(userId: string, playlistId: string): Promise<void> {
  const { count } = await getDb().playlist.deleteMany({
    where: { id: playlistId, ownerId: userId },
  });
  if (count === 0) throw new NotFoundError('Playlist not found.');
}

export async function addTrackToPlaylist(userId: string, playlistId: string, input: unknown) {
  const track = parseOrThrow(addTrackSchema, input);
  const db = getDb();

  try {
    // Interactive transaction: the position is derived from the *actual* max
    // inside the transaction, not a value read earlier — two concurrent adds
    // would otherwise both compute the same position and hit the
    // (playlistId, position) unique index.
    return await db.$transaction(async (tx) => {
      const playlist = await tx.playlist.findFirst({
        where: { id: playlistId, ownerId: userId },
        select: { id: true, trackCount: true },
      });
      if (playlist === null) throw new NotFoundError('Playlist not found.');
      if (playlist.trackCount >= LIMITS.PLAYLIST_MAX_TRACKS) {
        throw new ConflictError(
          `This playlist is full (${String(LIMITS.PLAYLIST_MAX_TRACKS)} tracks).`,
        );
      }

      const maxPosition = await tx.playlistTrack.aggregate({
        where: { playlistId },
        _max: { position: true },
      });

      const created = await tx.playlistTrack.create({
        data: {
          playlistId,
          position: (maxPosition._max.position ?? -1) + 1,
          encoded: track.encoded,
          identifier: track.identifier,
          title: track.title,
          author: track.author,
          durationMs: track.durationMs,
          uri: track.uri ?? null,
          artworkUrl: track.artworkUrl ?? null,
          source: SOURCE_TO_DB[track.source],
        },
      });
      await tx.playlist.update({
        where: { id: playlistId },
        data: { trackCount: { increment: 1 } },
      });
      return created;
    });
  } catch (error) {
    // A racer can still win the position between our read and write; surface
    // it as a retryable conflict instead of an opaque 500.
    if (isUniqueConstraintError(error)) {
      throw new ConflictError('The playlist changed while adding — try again.');
    }
    throw error;
  }
}

export async function removeTrackFromPlaylist(
  userId: string,
  playlistId: string,
  trackId: string,
): Promise<void> {
  const db = getDb();

  const playlist = await db.playlist.findFirst({
    where: { id: playlistId, ownerId: userId },
    select: { id: true },
  });
  if (playlist === null) throw new NotFoundError('Playlist not found.');

  const track = await db.playlistTrack.findFirst({
    where: { id: trackId, playlistId },
    select: { id: true, position: true },
  });
  if (track === null) throw new NotFoundError('Track not found in that playlist.');

  /**
   * Two-phase gap close. A single `position - 1` updateMany can transiently
   * collide with the (playlistId, position) unique index depending on row
   * visit order, since Postgres validates non-deferrable uniques per row.
   * Moving the tail far above the live range first makes every intermediate
   * state collision-free regardless of order.
   */
  const SHIFT_OFFSET = 1_000_000;
  await db.$transaction([
    db.playlistTrack.delete({ where: { id: track.id } }),
    db.playlistTrack.updateMany({
      where: { playlistId, position: { gt: track.position } },
      data: { position: { increment: SHIFT_OFFSET } },
    }),
    db.playlistTrack.updateMany({
      where: { playlistId, position: { gt: SHIFT_OFFSET } },
      data: { position: { decrement: SHIFT_OFFSET + 1 } },
    }),
    db.playlist.update({
      where: { id: playlistId },
      data: { trackCount: { decrement: 1 } },
    }),
  ]);
}

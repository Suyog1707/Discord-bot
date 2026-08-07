/**
 * Playlist management for slash commands.
 *
 * Same ownership model as favorites: playlists hang off the `User` row and a
 * bot-only user gets a minimal row on first write, so everything created here
 * appears on the dashboard the day they sign in. Guild-shared playlists
 * (`/playlist share`) set `guildId` + PUBLIC visibility and become playable
 * by everyone in that server.
 */
import {
  MusicSource as DbMusicSource,
  PlaylistVisibility,
  type Playlist,
  type PlaylistTrack,
  type PrismaClient,
} from '@discord-music/database';
import {
  ConflictError,
  LIMITS,
  NotFoundError,
  PLAYLIST_EXPORT_FORMAT,
  type MusicSource,
  type PlaylistExport,
} from '@discord-music/shared';

import type { QueuedTrack } from '../music/track.js';

const TO_DB_SOURCE: Record<MusicSource, DbMusicSource> = {
  youtube: DbMusicSource.YOUTUBE,
  spotify: DbMusicSource.SPOTIFY,
  soundcloud: DbMusicSource.SOUNDCLOUD,
  deezer: DbMusicSource.DEEZER,
};

const FROM_DB_SOURCE: Record<DbMusicSource, MusicSource> = {
  [DbMusicSource.YOUTUBE]: 'youtube',
  [DbMusicSource.SPOTIFY]: 'spotify',
  [DbMusicSource.SOUNDCLOUD]: 'soundcloud',
  [DbMusicSource.DEEZER]: 'deezer',
};

export interface PlaylistRef {
  readonly discordId: string;
  readonly username: string;
  /** Set when invoked in a guild — enables guild-shared lookups. */
  readonly guildId: string | null;
}

export class PlaylistsService {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async #userIdFor(ref: PlaylistRef): Promise<string> {
    const user = await this.#prisma.user.upsert({
      where: { discordId: ref.discordId },
      update: {},
      create: { discordId: ref.discordId, username: ref.username },
      select: { id: true },
    });
    return user.id;
  }

  /** The caller's own playlist by (case-insensitive) name. */
  async #owned(ref: PlaylistRef, name: string): Promise<Playlist> {
    const playlist = await this.#prisma.playlist.findFirst({
      where: {
        owner: { discordId: ref.discordId },
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (playlist === null) {
      throw new NotFoundError(`You have no playlist called **${name}**.`);
    }
    return playlist;
  }

  /**
   * Resolve by name for reading/playing: the caller's own playlists first,
   * then playlists shared with the current guild.
   */
  async resolve(ref: PlaylistRef, name: string): Promise<Playlist> {
    const own = await this.#prisma.playlist.findFirst({
      where: {
        owner: { discordId: ref.discordId },
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (own !== null) return own;

    const guildRowId = await this.#guildRowId(ref.guildId);
    if (guildRowId !== null) {
      const shared = await this.#prisma.playlist.findFirst({
        where: {
          guildId: guildRowId,
          visibility: PlaylistVisibility.PUBLIC,
          name: { equals: name, mode: 'insensitive' },
        },
      });
      if (shared !== null) return shared;
    }
    throw new NotFoundError(`No playlist called **${name}** here.`);
  }

  /** Internal Guild row id for a Discord snowflake, or null when unknown. */
  async #guildRowId(discordGuildId: string | null): Promise<string | null> {
    if (discordGuildId === null) return null;
    const guild = await this.#prisma.guild.findUnique({
      where: { discordId: discordGuildId },
      select: { id: true },
    });
    return guild?.id ?? null;
  }

  async tracks(
    playlistId: string,
    limit: number = LIMITS.PLAYLIST_MAX_TRACKS,
  ): Promise<PlaylistTrack[]> {
    return this.#prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      take: limit,
    });
  }

  async create(ref: PlaylistRef, name: string, folder: string | null): Promise<Playlist> {
    const userId = await this.#userIdFor(ref);

    const count = await this.#prisma.playlist.count({ where: { ownerId: userId } });
    if (count >= LIMITS.PLAYLIST_MAX_PER_USER) {
      throw new ConflictError(
        `You have reached the limit of ${String(LIMITS.PLAYLIST_MAX_PER_USER)} playlists.`,
      );
    }
    const clash = await this.#prisma.playlist.findUnique({
      where: { ownerId_name: { ownerId: userId, name } },
      select: { id: true },
    });
    if (clash !== null) {
      throw new ConflictError(`You already have a playlist called **${name}**.`);
    }
    return this.#prisma.playlist.create({ data: { ownerId: userId, name, folder } });
  }

  async delete(ref: PlaylistRef, name: string): Promise<string> {
    const playlist = await this.#owned(ref, name);
    await this.#prisma.playlist.delete({ where: { id: playlist.id } });
    return playlist.name;
  }

  async rename(ref: PlaylistRef, name: string, newName: string): Promise<Playlist> {
    const playlist = await this.#owned(ref, name);
    const clash = await this.#prisma.playlist.findFirst({
      where: { ownerId: playlist.ownerId, name: newName, id: { not: playlist.id } },
      select: { id: true },
    });
    if (clash !== null) {
      throw new ConflictError(`You already have a playlist called **${newName}**.`);
    }
    return this.#prisma.playlist.update({ where: { id: playlist.id }, data: { name: newName } });
  }

  /** Own playlists (favorites first) plus ones shared with this guild. */
  async list(ref: PlaylistRef): Promise<{ own: Playlist[]; shared: Playlist[] }> {
    const own = await this.#prisma.playlist.findMany({
      where: { owner: { discordId: ref.discordId } },
      orderBy: [{ favorite: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
    });
    const guildRowId = await this.#guildRowId(ref.guildId);
    const shared =
      guildRowId === null
        ? []
        : await this.#prisma.playlist.findMany({
            where: {
              guildId: guildRowId,
              visibility: PlaylistVisibility.PUBLIC,
              owner: { discordId: { not: ref.discordId } },
            },
            orderBy: { updatedAt: 'desc' },
            take: 25,
          });
    return { own, shared };
  }

  /** Name search across own + guild-shared playlists. */
  async search(ref: PlaylistRef, query: string): Promise<Playlist[]> {
    const guildRowId = await this.#guildRowId(ref.guildId);
    return this.#prisma.playlist.findMany({
      where: {
        name: { contains: query, mode: 'insensitive' },
        OR: [
          { owner: { discordId: ref.discordId } },
          ...(guildRowId === null
            ? []
            : [{ guildId: guildRowId, visibility: PlaylistVisibility.PUBLIC }]),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 15,
    });
  }

  async addTrack(ref: PlaylistRef, name: string, track: QueuedTrack): Promise<Playlist> {
    const playlist = await this.#owned(ref, name);
    if (playlist.trackCount >= LIMITS.PLAYLIST_MAX_TRACKS) {
      throw new ConflictError(
        `**${playlist.name}** is full (${String(LIMITS.PLAYLIST_MAX_TRACKS)} tracks).`,
      );
    }
    const [, updated] = await this.#prisma.$transaction([
      this.#prisma.playlistTrack.create({
        data: {
          playlistId: playlist.id,
          position: playlist.trackCount,
          encoded: track.encoded,
          identifier: track.identifier,
          title: track.title,
          author: track.author,
          durationMs: track.durationMs,
          uri: track.uri,
          artworkUrl: track.artworkUrl,
          source: TO_DB_SOURCE[track.source],
        },
      }),
      this.#prisma.playlist.update({
        where: { id: playlist.id },
        data: { trackCount: { increment: 1 } },
      }),
    ]);
    return updated;
  }

  /** Remove the track at a 1-based position, closing the gap. */
  async removeTrack(
    ref: PlaylistRef,
    name: string,
    position: number,
  ): Promise<{ playlist: Playlist; removed: PlaylistTrack }> {
    const playlist = await this.#owned(ref, name);
    const removed = await this.#prisma.playlistTrack.findUnique({
      where: { playlistId_position: { playlistId: playlist.id, position: position - 1 } },
    });
    if (removed === null) {
      throw new NotFoundError(
        `**${playlist.name}** has no track ${String(position)} (${String(playlist.trackCount)} total).`,
      );
    }

    // Two-phase gap close: shift the tail far above the live range first so
    // no intermediate state collides with the (playlistId, position) unique.
    const SHIFT_OFFSET = 1_000_000;
    await this.#prisma.$transaction([
      this.#prisma.playlistTrack.delete({ where: { id: removed.id } }),
      this.#prisma.playlistTrack.updateMany({
        where: { playlistId: playlist.id, position: { gt: removed.position } },
        data: { position: { increment: SHIFT_OFFSET } },
      }),
      this.#prisma.playlistTrack.updateMany({
        where: { playlistId: playlist.id, position: { gt: SHIFT_OFFSET } },
        data: { position: { decrement: SHIFT_OFFSET + 1 } },
      }),
      this.#prisma.playlist.update({
        where: { id: playlist.id },
        data: { trackCount: { decrement: 1 } },
      }),
    ]);
    return { playlist, removed };
  }

  /** Toggle sharing with the current guild. Returns the new shared state. */
  async toggleShare(ref: PlaylistRef, name: string, guildName: string): Promise<boolean> {
    if (ref.guildId === null) throw new ConflictError('Sharing only works inside a server.');
    const playlist = await this.#owned(ref, name);

    // The Guild row normally exists from `guildCreate`; create a minimal one
    // if the bot somehow never recorded it.
    const guild = await this.#prisma.guild.upsert({
      where: { discordId: ref.guildId },
      update: {},
      create: { discordId: ref.guildId, name: guildName },
      select: { id: true },
    });

    if (playlist.guildId === guild.id) {
      await this.#prisma.playlist.update({
        where: { id: playlist.id },
        data: { guildId: null, visibility: PlaylistVisibility.PRIVATE },
      });
      return false;
    }

    await this.#prisma.playlist.update({
      where: { id: playlist.id },
      data: { guildId: guild.id, visibility: PlaylistVisibility.PUBLIC },
    });
    return true;
  }

  /** Toggle the favorite star. Returns the new state. */
  async toggleFavorite(ref: PlaylistRef, name: string): Promise<boolean> {
    const playlist = await this.#owned(ref, name);
    const updated = await this.#prisma.playlist.update({
      where: { id: playlist.id },
      data: { favorite: !playlist.favorite },
      select: { favorite: true },
    });
    return updated.favorite;
  }

  async duplicate(ref: PlaylistRef, name: string): Promise<Playlist> {
    const source = await this.resolve(ref, name);
    const tracks = await this.tracks(source.id);
    const doc: PlaylistExport = {
      format: PLAYLIST_EXPORT_FORMAT,
      name: `${source.name} (copy)`.slice(0, LIMITS.PLAYLIST_NAME_MAX_LENGTH),
      description: source.description,
      folder: source.folder,
      tracks: tracks.map((track) => ({
        encoded: track.encoded === '' ? undefined : track.encoded,
        identifier: track.identifier,
        title: track.title,
        author: track.author,
        durationMs: track.durationMs,
        uri: track.uri,
        artworkUrl: track.artworkUrl,
        source: FROM_DB_SOURCE[track.source],
      })),
    };
    return this.import(ref, doc);
  }

  async export(ref: PlaylistRef, name: string): Promise<PlaylistExport> {
    const playlist = await this.resolve(ref, name);
    const tracks = await this.tracks(playlist.id);
    return {
      format: PLAYLIST_EXPORT_FORMAT,
      name: playlist.name,
      description: playlist.description,
      folder: playlist.folder,
      tracks: tracks.map((track) => ({
        encoded: track.encoded === '' ? undefined : track.encoded,
        identifier: track.identifier,
        title: track.title,
        author: track.author,
        durationMs: track.durationMs,
        uri: track.uri,
        artworkUrl: track.artworkUrl,
        source: FROM_DB_SOURCE[track.source],
      })),
    };
  }

  /** Create a playlist from an already-validated portable document. */
  async import(ref: PlaylistRef, doc: PlaylistExport): Promise<Playlist> {
    const userId = await this.#userIdFor(ref);

    const count = await this.#prisma.playlist.count({ where: { ownerId: userId } });
    if (count >= LIMITS.PLAYLIST_MAX_PER_USER) {
      throw new ConflictError(
        `You have reached the limit of ${String(LIMITS.PLAYLIST_MAX_PER_USER)} playlists.`,
      );
    }
    const clash = await this.#prisma.playlist.findUnique({
      where: { ownerId_name: { ownerId: userId, name: doc.name } },
      select: { id: true },
    });
    const finalName =
      clash === null
        ? doc.name
        : `${doc.name} (imported)`.slice(0, LIMITS.PLAYLIST_NAME_MAX_LENGTH);

    return this.#prisma.playlist.create({
      data: {
        ownerId: userId,
        name: finalName,
        description: doc.description,
        folder: doc.folder,
        trackCount: doc.tracks.length,
        tracks: {
          create: doc.tracks.map((track, position) => ({
            position,
            encoded: track.encoded ?? '',
            identifier: track.identifier,
            title: track.title,
            author: track.author,
            durationMs: track.durationMs,
            uri: track.uri ?? null,
            artworkUrl: track.artworkUrl ?? null,
            source: TO_DB_SOURCE[track.source],
          })),
        },
      },
    });
  }

  async recordPlay(playlistId: string): Promise<void> {
    await this.#prisma.playlist.update({
      where: { id: playlistId },
      data: { playCount: { increment: 1 } },
    });
  }

  /** Names for autocomplete: own + guild-shared, filtered by prefix. */
  async names(ref: PlaylistRef, query: string): Promise<string[]> {
    const guildRowId = await this.#guildRowId(ref.guildId);
    const rows = await this.#prisma.playlist.findMany({
      where: {
        ...(query === '' ? {} : { name: { contains: query, mode: 'insensitive' } }),
        OR: [
          { owner: { discordId: ref.discordId } },
          ...(guildRowId === null
            ? []
            : [{ guildId: guildRowId, visibility: PlaylistVisibility.PUBLIC }]),
        ],
      },
      orderBy: [{ favorite: 'desc' }, { updatedAt: 'desc' }],
      select: { name: true },
      take: 25,
    });
    return [...new Set(rows.map((row) => row.name))];
  }
}

import 'server-only';

/**
 * Spotify account linking, token lifecycle and playlist import/sync.
 *
 * Tokens are encrypted before storage and decrypted only transiently for API
 * calls. Refresh happens automatically 60s before expiry; a refresh that
 * fails with a decryption error (rotated NEXTAUTH_SECRET) surfaces as
 * "relink required" instead of a 500.
 */
import {
  ConflictError,
  LIMITS,
  NotFoundError,
  UpstreamError,
  spotifyPlaylistCount,
} from '@discord-music/shared';

import { decryptToken, encryptToken } from '@/lib/crypto';
import { getDb } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import {
  exchangeCode,
  getPlaylistMeta,
  getPlaylistTracks,
  getProfile,
  getSavedTracks,
  listPlaylists,
  refreshTokens,
  type SpotifyTrack,
} from '@/lib/spotify/client';

const EXPIRY_SKEW_MS = 60_000;
/** Sentinel spotifyId marking a playlist imported from Liked Songs. */
const LIKED_SONGS_ID = 'liked-songs';

/* ------------------------------------------------------------------ linking */

export async function completeLink(userId: string, code: string): Promise<void> {
  const tokens = await exchangeCode(code);
  const profile = await getProfile(tokens.accessToken);

  await getDb().spotifyAccount.upsert({
    where: { userId },
    update: {
      spotifyId: profile.id,
      displayName: profile.display_name,
      country: profile.country ?? null,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    },
    create: {
      userId,
      spotifyId: profile.id,
      displayName: profile.display_name,
      country: profile.country ?? null,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    },
  });
}

export async function disconnectSpotify(userId: string): Promise<void> {
  const { count } = await getDb().spotifyAccount.deleteMany({ where: { userId } });
  if (count === 0) throw new NotFoundError('No Spotify account is linked.');
}

export interface SpotifyStatus {
  readonly linked: boolean;
  readonly displayName: string | null;
  readonly spotifyId: string | null;
  readonly country: string | null;
  readonly scopes: readonly string[];
  readonly linkedAt: Date | null;
  /** Whether this library may steer autoplay in a shared voice channel. */
  readonly autoplayOptIn: boolean;
}

export async function getSpotifyStatus(userId: string): Promise<SpotifyStatus> {
  const account = await getDb().spotifyAccount.findUnique({
    where: { userId },
    select: {
      displayName: true,
      spotifyId: true,
      country: true,
      scopes: true,
      createdAt: true,
      autoplayOptIn: true,
    },
  });
  if (account === null) {
    return {
      linked: false,
      displayName: null,
      spotifyId: null,
      country: null,
      scopes: [],
      linkedAt: null,
      autoplayOptIn: false,
    };
  }
  return {
    linked: true,
    displayName: account.displayName,
    spotifyId: account.spotifyId,
    country: account.country,
    scopes: account.scopes.split(' '),
    autoplayOptIn: account.autoplayOptIn,
    linkedAt: account.createdAt,
  };
}

/** Decrypt, refresh when near expiry, persist rotations, return plaintext. */
export async function getValidAccessToken(userId: string): Promise<string> {
  const db = getDb();
  const account = await db.spotifyAccount.findUnique({ where: { userId } });
  if (account === null) {
    throw new NotFoundError('Link your Spotify account first.');
  }

  const accessToken = decryptToken(account.accessToken);
  const refreshToken = decryptToken(account.refreshToken);
  if (accessToken === null || refreshToken === null) {
    // Encryption key rotated since linking — stored tokens are unreadable.
    await db.spotifyAccount.delete({ where: { id: account.id } }).catch(() => undefined);
    throw new UpstreamError('Your Spotify link expired — please connect it again.');
  }

  if (account.expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
    return accessToken;
  }

  const refreshed = await refreshTokens(refreshToken);
  await db.spotifyAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptToken(refreshed.accessToken),
      refreshToken: encryptToken(refreshed.refreshToken),
      expiresAt: refreshed.expiresAt,
    },
  });
  return refreshed.accessToken;
}

/* ---------------------------------------------------------------- importing */

export interface ImportableItem {
  readonly spotifyId: string;
  readonly name: string;
  readonly trackCount: number;
  readonly owner: string | null;
  /** Set when a local playlist already mirrors this Spotify item. */
  readonly importedPlaylistId: string | null;
}

export async function listImportable(userId: string): Promise<readonly ImportableItem[]> {
  const accessToken = await getValidAccessToken(userId);
  const [playlists, existing] = await Promise.all([
    listPlaylists(accessToken),
    getDb().playlist.findMany({
      where: { ownerId: userId, spotifyId: { not: null } },
      select: { id: true, spotifyId: true },
    }),
  ]);
  const bytSpotifyId = new Map(existing.map((row) => [row.spotifyId, row.id]));

  const items: ImportableItem[] = [
    {
      spotifyId: LIKED_SONGS_ID,
      name: 'Liked Songs',
      trackCount: 0,
      owner: null,
      importedPlaylistId: bytSpotifyId.get(LIKED_SONGS_ID) ?? null,
    },
    ...playlists.map((playlist) => ({
      spotifyId: playlist.id,
      name: playlist.name,
      trackCount: spotifyPlaylistCount(playlist),
      owner: playlist.owner?.display_name ?? null,
      importedPlaylistId: bytSpotifyId.get(playlist.id) ?? null,
    })),
  ];
  return items;
}

function toInternalTrack(track: SpotifyTrack, position: number) {
  return {
    position,
    encoded: '', // re-resolved by URI at play time — Spotify audio is never streamed
    identifier: `spotify:track:${track.id ?? String(position)}`,
    title: track.name,
    author: track.artists.map((artist) => artist.name).join(', '),
    durationMs: track.duration_ms,
    uri: track.external_urls?.spotify ?? null,
    artworkUrl: track.album?.images?.[0]?.url ?? null,
    source: 'SPOTIFY' as const,
  };
}

/**
 * Import a Spotify playlist (or Liked Songs) as a local playlist, or
 * re-synchronise the existing mirror. Sync replaces the track list only when
 * Spotify's snapshot changed, so repeated syncs are cheap and idempotent.
 */
export async function importSpotifyItem(
  userId: string,
  spotifyId: string,
): Promise<{ playlistId: string; name: string; trackCount: number; changed: boolean }> {
  const db = getDb();
  const accessToken = await getValidAccessToken(userId);
  const logger = getLogger('spotify-import').child({ userId, spotifyId });

  let name: string;
  let snapshotId: string | null;
  let tracks: readonly SpotifyTrack[];

  if (spotifyId === LIKED_SONGS_ID) {
    name = 'Liked Songs';
    snapshotId = null; // Spotify exposes no snapshot for the library — always refresh.
    tracks = await getSavedTracks(accessToken, LIMITS.PLAYLIST_MAX_TRACKS);
  } else {
    const meta = await getPlaylistMeta(accessToken, spotifyId);
    name = meta.name;
    snapshotId = meta.snapshot_id;

    const existing = await db.playlist.findFirst({
      where: { ownerId: userId, spotifyId },
      select: { id: true, spotifySnapshotId: true, trackCount: true, name: true },
    });
    if (existing !== null && snapshotId === existing.spotifySnapshotId) {
      return {
        playlistId: existing.id,
        name: existing.name,
        trackCount: existing.trackCount,
        changed: false,
      };
    }
    tracks = await getPlaylistTracks(accessToken, spotifyId, LIMITS.PLAYLIST_MAX_TRACKS);
  }

  const existing = await db.playlist.findFirst({
    where: { ownerId: userId, spotifyId },
    select: { id: true },
  });

  if (existing === null) {
    const count = await db.playlist.count({ where: { ownerId: userId } });
    if (count >= LIMITS.PLAYLIST_MAX_PER_USER) {
      throw new ConflictError(
        `You have reached the limit of ${String(LIMITS.PLAYLIST_MAX_PER_USER)} playlists.`,
      );
    }
  }

  const data = tracks.map((track, position) => toInternalTrack(track, position));
  const playlistId = await db.$transaction(async (tx) => {
    if (existing !== null) {
      await tx.playlistTrack.deleteMany({ where: { playlistId: existing.id } });
      await tx.playlist.update({
        where: { id: existing.id },
        data: {
          spotifySnapshotId: snapshotId,
          syncedAt: new Date(),
          trackCount: data.length,
          tracks: { create: data },
        },
      });
      return existing.id;
    }

    const nameClash = await tx.playlist.findUnique({
      where: { ownerId_name: { ownerId: userId, name } },
      select: { id: true },
    });
    const created = await tx.playlist.create({
      data: {
        ownerId: userId,
        name: nameClash === null ? name : `${name} (Spotify)`.slice(0, 100),
        folder: 'Spotify',
        spotifyId,
        spotifySnapshotId: snapshotId,
        syncedAt: new Date(),
        trackCount: data.length,
        tracks: { create: data },
      },
      select: { id: true },
    });
    return created.id;
  });

  logger.info({ playlistId, tracks: data.length }, 'Spotify import complete');
  return { playlistId, name, trackCount: data.length, changed: true };
}

/** Re-sync one previously imported playlist by its local id. */
export async function syncSpotifyPlaylist(
  userId: string,
  playlistId: string,
): Promise<{ trackCount: number; changed: boolean }> {
  const playlist = await getDb().playlist.findFirst({
    where: { id: playlistId, ownerId: userId },
    select: { spotifyId: true },
  });
  if (playlist === null) throw new NotFoundError('Playlist not found.');
  if (playlist.spotifyId === null) {
    throw new ConflictError('This playlist was not imported from Spotify.');
  }
  const result = await importSpotifyItem(userId, playlist.spotifyId);
  return { trackCount: result.trackCount, changed: result.changed };
}

/**
 * Turn autoplay personalisation on or off for this account.
 *
 * Separate from linking on purpose. Connecting Spotify is about playback the
 * user asks for one action at a time; letting the same library quietly steer
 * what a whole voice channel hears is a different thing to agree to, and has
 * to be refusable without unlinking.
 */
export async function setSpotifyAutoplayOptIn(userId: string, optIn: boolean): Promise<void> {
  await getDb().spotifyAccount.updateMany({ where: { userId }, data: { autoplayOptIn: optIn } });
}

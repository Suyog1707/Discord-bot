/**
 * Linked-Spotify-account access for slash commands.
 *
 * The dashboard performs the OAuth flow and stores AES-256-GCM-encrypted
 * tokens (apps/web/src/lib/crypto.ts). This service is the bot-side reader:
 * it decrypts with the same NEXTAUTH_SECRET-derived key, refreshes near
 * expiry (persisting rotations), and exposes the read calls `/spotify`
 * needs. Everything degrades gracefully: without SPOTIFY_CLIENT_ID/SECRET or
 * NEXTAUTH_SECRET the commands point the user at the dashboard instead.
 *
 * Spotify audio is never streamed — playlist playback goes through metadata →
 * Lavalink search, exactly like Spotify URLs.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, SpotifyAccount } from '@discord-music/database';
import { ConflictError, LIMITS, NotFoundError, UpstreamError } from '@discord-music/shared';

import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { SpotifyTrackMeta } from '../music/spotify-resolver.js';

const logger = getLogger('spotify-account');

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const TIMEOUT_MS = 10_000;
const EXPIRY_SKEW_MS = 60_000;

/** Sentinel id for the user's Liked Songs (mirrors the web importer). */
export const LIKED_SONGS_ID = 'liked-songs';

/* -------------------------------------------------------- token encryption */
// Mirror of apps/web/src/lib/crypto.ts — same derivation, same v1 format.

const CRYPTO_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function encryptionKey(): Buffer | null {
  const secret = getEnv().NEXTAUTH_SECRET;
  if (secret === undefined) return null;
  return createHash('sha256').update(`${secret}:token-encryption`).digest();
}

function decryptToken(stored: string): string | null {
  const key = encryptionKey();
  const [version, ivPart, dataPart, tagPart] = stored.split('.');
  if (
    key === null ||
    version !== CRYPTO_VERSION ||
    ivPart === undefined ||
    dataPart === undefined ||
    tagPart === undefined
  ) {
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function encryptToken(plaintext: string): string {
  const key = encryptionKey();
  if (key === null) throw new UpstreamError('Token encryption key is not configured.');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    CRYPTO_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/* --------------------------------------------------------------- API types */

interface RawTrack {
  readonly id: string | null;
  readonly name: string;
  readonly duration_ms: number;
  readonly artists: readonly { readonly name: string }[];
  readonly album?: {
    readonly name?: string;
    readonly images?: readonly { readonly url: string }[];
  };
  readonly external_urls?: { readonly spotify?: string };
  readonly is_local?: boolean;
}

export interface UserPlaylist {
  readonly spotifyId: string;
  readonly name: string;
  readonly trackCount: number;
  readonly owner: string | null;
  readonly artworkUrl: string | null;
  readonly isPublic: boolean | null;
  readonly snapshotId: string | null;
}

export interface UserTrack extends SpotifyTrackMeta {
  readonly spotifyId: string | null;
  readonly uri: string | null;
}

function toUserTrack(track: RawTrack): UserTrack {
  const spotifyUrl =
    track.external_urls?.spotify ??
    (track.id === null ? null : `https://open.spotify.com/track/${track.id}`);
  return {
    spotifyId: track.id,
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(', '),
    durationMs: track.duration_ms,
    artworkUrl: track.album?.images?.[0]?.url ?? null,
    isrc: null,
    album: track.album?.name ?? null,
    spotifyUrl,
    uri: spotifyUrl,
  };
}

export class SpotifyService {
  readonly #prisma: PrismaClient;
  /**
   * Decrypted access tokens, held until shortly before Spotify expires them.
   *
   * Without this every Spotify `/play` pays a database read plus an AES
   * decrypt before the first byte of metadata is requested; the token is valid
   * for an hour, so re-deriving it per command is pure latency.
   */
  readonly #tokenCache = new Map<string, { value: string; expiresAt: number }>();

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /** Client credentials present — URL playback and refresh both need them. */
  isConfigured(): boolean {
    const env = getEnv();
    return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
  }

  /** Whether the bot can read tokens the dashboard stored. */
  canReadTokens(): boolean {
    return this.isConfigured() && getEnv().NEXTAUTH_SECRET !== undefined;
  }

  async status(discordId: string): Promise<SpotifyAccount | null> {
    return this.#prisma.spotifyAccount.findFirst({ where: { user: { discordId } } });
  }

  /**
   * Playback-only token lookup. An absent link is normal for `/play` and must
   * not turn a public Spotify URL into an account-linking requirement.
   */
  async accessTokenForPlayback(discordId: string): Promise<string | null> {
    if (!this.canReadTokens()) return null;
    const cached = this.#tokenCache.get(discordId);
    if (cached !== undefined && cached.expiresAt - Date.now() > EXPIRY_SKEW_MS) return cached.value;

    const account = await this.status(discordId);
    // No link is normal for `/play`: the caller falls back to public metadata.
    return account === null ? null : this.#validAccessToken(discordId, account);
  }

  /** Unlink. Returns false when nothing was linked. */
  async disconnect(discordId: string): Promise<boolean> {
    this.#tokenCache.delete(discordId);
    const { count } = await this.#prisma.spotifyAccount.deleteMany({
      where: { user: { discordId } },
    });
    return count > 0;
  }

  /**
   * @param known The already-fetched account row, when the caller has one —
   * re-reading it here would double the database cost of every Spotify command.
   */
  async #validAccessToken(discordId: string, known?: SpotifyAccount): Promise<string> {
    const cached = this.#tokenCache.get(discordId);
    if (cached !== undefined && cached.expiresAt - Date.now() > EXPIRY_SKEW_MS) return cached.value;

    const account = known ?? (await this.status(discordId));
    if (account === null) {
      throw new NotFoundError(
        'No Spotify account linked — connect one with `/spotify connect` first.',
      );
    }

    const accessToken = decryptToken(account.accessToken);
    const refreshToken = decryptToken(account.refreshToken);
    if (accessToken === null || refreshToken === null) {
      throw new UpstreamError(
        'Your Spotify link cannot be read here — reconnect it on the dashboard.',
      );
    }

    if (account.expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
      this.#tokenCache.set(discordId, {
        value: accessToken,
        expiresAt: account.expiresAt.getTime(),
      });
      return accessToken;
    }

    const env = getEnv();
    if (env.SPOTIFY_CLIENT_ID === undefined || env.SPOTIFY_CLIENT_SECRET === undefined) {
      throw new UpstreamError('Spotify is not configured on the bot.');
    }
    let response: Response;
    try {
      response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError('Spotify did not respond in time. Try again shortly.', {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError(
        'Your Spotify connection expired. Reconnect it on the dashboard and try again.',
      );
    }
    if (response.status === 429) {
      throw new UpstreamError('Spotify is rate limiting requests. Try again shortly.');
    }
    if (!response.ok) throw new UpstreamError('Spotify token refresh failed. Try again shortly.');
    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const expiresAt = Date.now() + data.expires_in * 1000;
    this.#tokenCache.set(discordId, { value: data.access_token, expiresAt });

    await this.#prisma.spotifyAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encryptToken(data.access_token),
        // Spotify usually keeps the refresh token; rotate when it sends a new one.
        refreshToken: encryptToken(data.refresh_token ?? refreshToken),
        expiresAt: new Date(expiresAt),
      },
    });
    return data.access_token;
  }

  async #apiGet<T>(discordId: string, path: string): Promise<T> {
    const token = await this.#validAccessToken(discordId);
    let response: Response;
    try {
      response = await fetch(path.startsWith('https://') ? path : `${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError('Spotify did not respond in time. Try again shortly.', {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError('Spotify denied that request. Reconnect your account and try again.');
    }
    if (response.status === 404) throw new NotFoundError('That Spotify item no longer exists.');
    if (response.status === 429) {
      throw new UpstreamError('Spotify is rate limiting requests. Try again shortly.');
    }
    if (!response.ok) throw new UpstreamError('Spotify request failed. Try again shortly.');
    return (await response.json()) as T;
  }

  /** The user's playlists (Liked Songs first), newest-touched first. */
  async listPlaylists(discordId: string): Promise<UserPlaylist[]> {
    interface Page {
      items: {
        id: string;
        name: string;
        snapshot_id: string;
        items: { total: number };
        owner: { display_name: string | null };
        images?: { url: string }[] | null;
        public: boolean | null;
      }[];
      next: string | null;
    }

    const collected: UserPlaylist[] = [
      {
        spotifyId: LIKED_SONGS_ID,
        name: 'Liked Songs',
        trackCount: 0,
        owner: null,
        artworkUrl: null,
        isPublic: false,
        snapshotId: null,
      },
    ];
    let url: string | null = '/me/playlists?limit=50';
    while (url !== null && collected.length < 200) {
      const page: Page = await this.#apiGet(discordId, url);
      collected.push(
        ...page.items.map((item) => ({
          spotifyId: item.id,
          name: item.name,
          trackCount: item.items.total,
          owner: item.owner.display_name,
          artworkUrl: item.images?.[0]?.url ?? null,
          isPublic: item.public,
          snapshotId: item.snapshot_id,
        })),
      );
      url = page.next;
    }
    return collected;
  }

  /** Tracks of a playlist (or Liked Songs), local files skipped. */
  async playlistTracks(discordId: string, spotifyId: string, limit: number): Promise<UserTrack[]> {
    const collected: UserTrack[] = [];
    let url: string | null =
      spotifyId === LIKED_SONGS_ID
        ? '/me/tracks?limit=50'
        : `/playlists/${spotifyId}/items?limit=100`;

    while (url !== null && collected.length < limit) {
      const page: { items: { item: RawTrack | null }[]; next: string | null } = await this.#apiGet(
        discordId,
        url,
      );
      for (const item of page.items) {
        if (item.item !== null && item.item.is_local !== true) {
          collected.push(toUserTrack(item.item));
        }
      }
      url = page.next;
    }
    return collected.slice(0, limit);
  }

  /**
   * Import (or re-sync) one Spotify playlist as a local playlist, mirroring
   * the dashboard importer: snapshot-aware, filed under "Spotify", clash
   * names suffixed. Returns `changed: false` when the snapshot is current.
   */
  async importItem(
    discordId: string,
    item: UserPlaylist,
  ): Promise<{ name: string; trackCount: number; changed: boolean }> {
    const user = await this.#prisma.user.findUnique({
      where: { discordId },
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundError('Link your Spotify account on the dashboard first.');
    }

    const existing = await this.#prisma.playlist.findFirst({
      where: { ownerId: user.id, spotifyId: item.spotifyId },
      select: { id: true, spotifySnapshotId: true, trackCount: true, name: true },
    });
    if (
      existing !== null &&
      item.snapshotId !== null &&
      item.snapshotId === existing.spotifySnapshotId
    ) {
      return { name: existing.name, trackCount: existing.trackCount, changed: false };
    }

    if (existing === null) {
      const count = await this.#prisma.playlist.count({ where: { ownerId: user.id } });
      if (count >= LIMITS.PLAYLIST_MAX_PER_USER) {
        throw new ConflictError(
          `You have reached the limit of ${String(LIMITS.PLAYLIST_MAX_PER_USER)} playlists.`,
        );
      }
    }

    const tracks = await this.playlistTracks(discordId, item.spotifyId, LIMITS.PLAYLIST_MAX_TRACKS);
    const rows = tracks.map((track, position) => ({
      position,
      encoded: '', // re-resolved by URI/search at play time — never streamed from Spotify
      identifier: `spotify:track:${track.spotifyId ?? String(position)}`,
      title: track.title,
      author: track.artist,
      durationMs: track.durationMs,
      uri: track.uri,
      artworkUrl: track.artworkUrl,
      source: 'SPOTIFY' as const,
    }));

    const name = await this.#prisma.$transaction(async (tx) => {
      if (existing !== null) {
        await tx.playlistTrack.deleteMany({ where: { playlistId: existing.id } });
        await tx.playlist.update({
          where: { id: existing.id },
          data: {
            spotifySnapshotId: item.snapshotId,
            syncedAt: new Date(),
            trackCount: rows.length,
            tracks: { create: rows },
          },
        });
        return existing.name;
      }

      const clash = await tx.playlist.findUnique({
        where: { ownerId_name: { ownerId: user.id, name: item.name } },
        select: { id: true },
      });
      const finalName =
        clash === null
          ? item.name
          : `${item.name} (Spotify)`.slice(0, LIMITS.PLAYLIST_NAME_MAX_LENGTH);
      await tx.playlist.create({
        data: {
          ownerId: user.id,
          name: finalName,
          folder: 'Spotify',
          spotifyId: item.spotifyId,
          spotifySnapshotId: item.snapshotId,
          syncedAt: new Date(),
          trackCount: rows.length,
          tracks: { create: rows },
        },
      });
      return finalName;
    });

    logger.info({ discordId, spotifyId: item.spotifyId, tracks: rows.length }, 'Spotify import');
    return { name, trackCount: rows.length, changed: true };
  }
}

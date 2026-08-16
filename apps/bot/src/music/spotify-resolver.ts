/**
 * Spotify URL support: metadata from the Web API, audio from the configured
 * playback sources. Spotify audio is never streamed — a track/album/playlist/
 * artist URL resolves to metadata, and each track then finds its best
 * playable match through Lavalink search (`title artist`).
 *
 * Linked users resolve through their existing Spotify OAuth token. App tokens
 * are used only for public catalogue objects (tracks, albums and artists),
 * never as a way to read a user's playlist. Public playlists for unlinked
 * users use the data exposed by Spotify's public playlist page as a best-
 * effort fallback.
 */
import { UpstreamError, ValidationError } from '@discord-music/shared';

import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { SpotifyService } from '../services/spotify-service.js';

const logger = getLogger('spotify');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const TIMEOUT_MS = 10_000;
const ARTIST_TRACK_LIMIT = 10;

const URL_PATTERN =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/u;

export interface SpotifyTrackMeta {
  readonly title: string;
  readonly artist: string;
  readonly durationMs: number;
  readonly artworkUrl: string | null;
  readonly isrc: string | null;
}

export interface SpotifyResolution {
  /**
   * The first page of tracks — enough to start playback. A large collection
   * deliberately does not wait for its whole track list here: paging a
   * thousand-track playlist is seconds of latency in front of the first note.
   */
  readonly tracks: readonly SpotifyTrackMeta[];
  /** Set for album/playlist/artist URLs. */
  readonly collectionName: string | null;
  /**
   * Everything after {@link tracks}, fetched on demand once playback is under
   * way. Absent when the first page already held the entire collection.
   */
  readonly more?: (() => Promise<readonly SpotifyTrackMeta[]>) | undefined;
}

/** First-page size for paged collections; also Spotify's own page maximum. */
const PLAYLIST_PAGE_SIZE = 100;
const ALBUM_PAGE_SIZE = 50;
/** Parallel page fetches when expanding the tail of a collection. */
const PAGE_CONCURRENCY = 4;

/** Run `task` over `items` with a bounded number of concurrent calls, in order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}

export function isSpotifyUrl(input: string): boolean {
  return URL_PATTERN.test(input);
}

/** True for an open.spotify.com URL, including malformed/unsupported ones. */
export function isSpotifyWebUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.hostname === 'open.spotify.com'
      : false;
  } catch {
    return false;
  }
}

export function isSpotifyConfigured(): boolean {
  const env = getEnv();
  return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
}

function playlistTrackLimit(): number {
  return getEnv().SPOTIFY_PLAYLIST_MAX_TRACKS;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  if (cachedToken !== null && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.value;
  }

  const env = getEnv();
  if (env.SPOTIFY_CLIENT_ID === undefined || env.SPOTIFY_CLIENT_SECRET === undefined) {
    throw new UpstreamError(
      'Spotify links need SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET configured.',
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
      ).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new UpstreamError(`Spotify auth failed (${String(response.status)}).`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
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
  if (response.status === 404) {
    throw new ValidationError('That Spotify link points at nothing (deleted or private?).');
  }
  if (response.status === 401) {
    throw new UpstreamError(
      'Spotify authorization expired. Reconnect your Spotify account and try again.',
    );
  }
  if (response.status === 403) {
    throw new ValidationError('Spotify does not allow access to that item.');
  }
  if (response.status === 429) {
    throw new UpstreamError('Spotify is rate limiting requests. Try again shortly.');
  }
  if (!response.ok) {
    throw new UpstreamError(`Spotify lookup failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

async function catalogueGet<T>(path: string): Promise<T> {
  return apiGet<T>(path, await appToken());
}

interface RawTrack {
  readonly name: string;
  readonly duration_ms: number;
  readonly artists: readonly { readonly name: string }[];
  readonly album?: { readonly images?: readonly { readonly url: string }[] };
  readonly external_ids?: { readonly isrc?: string };
  readonly is_local?: boolean;
}

function toMeta(track: RawTrack, artworkFallback: string | null = null): SpotifyTrackMeta {
  return {
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(', '),
    durationMs: track.duration_ms,
    artworkUrl: track.album?.images?.[0]?.url ?? artworkFallback,
    isrc: track.external_ids?.isrc ?? null,
  };
}

interface PlaylistPage {
  readonly items?: readonly { readonly item: RawTrack | null }[];
  readonly next: string | null;
  readonly total?: number;
}

const PLAYLIST_ITEM_FIELDS =
  'items(item(name,duration_ms,artists(name),album(images),external_ids,is_local)),next,total';

function playablePlaylistTracks(page: PlaylistPage): RawTrack[] {
  if (page.items === undefined) {
    // Spotify returns playlist metadata but deliberately omits items for
    // playlists that the token holder does not own/collaborate on.
    throw new ValidationError('Spotify did not provide items for that playlist.');
  }
  return page.items.flatMap((entry) =>
    entry.item === null || entry.item.is_local === true ? [] : [entry.item],
  );
}

async function linkedPlaylist(id: string, token: string): Promise<SpotifyResolution> {
  const limit = playlistTrackLimit();
  const itemsPath = (offset: number): string =>
    `/playlists/${id}/items?limit=${String(PLAYLIST_PAGE_SIZE)}&offset=${String(offset)}` +
    `&fields=${PLAYLIST_ITEM_FIELDS}`;

  // Name and first page are independent lookups — no reason to serialise them.
  const [playlist, firstPage] = await Promise.all([
    apiGet<{ readonly name: string }>(`/playlists/${id}?fields=name`, token),
    apiGet<PlaylistPage>(itemsPath(0), token),
  ]);

  const first = playablePlaylistTracks(firstPage).slice(0, limit);
  const total = Math.min(firstPage.total ?? first.length, limit);
  const tailOffsets: number[] = [];
  for (let offset = PLAYLIST_PAGE_SIZE; offset < total; offset += PLAYLIST_PAGE_SIZE) {
    tailOffsets.push(offset);
  }

  return {
    tracks: first.map((track) => toMeta(track)),
    collectionName: playlist.name,
    more:
      tailOffsets.length === 0
        ? undefined
        : async () => {
            // Offsets are known up front, so the tail pages go out in parallel
            // instead of one `next` hop at a time.
            const pages = await mapBounded(tailOffsets, PAGE_CONCURRENCY, (offset) =>
              apiGet<PlaylistPage>(itemsPath(offset), token),
            );
            return pages
              .flatMap((page) => playablePlaylistTracks(page))
              .slice(0, Math.max(0, limit - first.length))
              .map((track) => toMeta(track));
          },
  };
}

function objectTracks(value: unknown, output: RawTrack[], limit: number): void {
  if (output.length >= limit || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) objectTracks(entry, output, limit);
    return;
  }
  const object = value as Record<string, unknown>;
  const candidate = object.item ?? object.track;
  if (candidate !== undefined) objectTracks(candidate, output, limit);
  const name = object.name;
  const artists = object.artists;
  const duration = object.duration_ms;
  if (
    typeof name === 'string' &&
    typeof duration === 'number' &&
    Array.isArray(artists) &&
    artists.every(
      (artist) =>
        artist !== null &&
        typeof artist === 'object' &&
        typeof (artist as { name?: unknown }).name === 'string',
    )
  ) {
    output.push(object as unknown as RawTrack);
    return;
  }
  for (const child of Object.values(object)) objectTracks(child, output, limit);
}

function htmlText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/giu,
      (_match, hex: string | undefined, decimal: string | undefined) =>
        String.fromCodePoint(Number.parseInt(hex ?? decimal ?? '0', hex === undefined ? 10 : 16)),
    )
    .trim();
}

function durationMs(value: string): number | null {
  const parts = value.trim().split(':').map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  const [minutes, seconds] = parts;
  if (minutes === undefined || seconds === undefined) return null;
  return (minutes * 60 + seconds) * 1000;
}

/** Spotify's public embed is server-rendered as a numbered h3/h4 track list. */
function embedTracks(html: string, limit: number, artworkUrl: string | null): SpotifyTrackMeta[] {
  const tracks: SpotifyTrackMeta[] = [];
  const pattern =
    /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]{0,2000}?<h4[^>]*>([\s\S]*?)<\/h4>[\s\S]{0,2000}?\b(\d{1,2}:\d{2})\b/giu;
  for (const match of html.matchAll(pattern)) {
    const title = htmlText(match[1] ?? '');
    const artist = htmlText(match[2] ?? '');
    const duration = durationMs(match[3] ?? '');
    if (title.length === 0 || artist.length === 0 || duration === null) continue;
    tracks.push({ title, artist, durationMs: duration, artworkUrl, isrc: null });
    if (tracks.length >= limit) break;
  }
  return tracks;
}

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const propertyFirst = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
    'iu',
  );
  const contentFirst = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
    'iu',
  );
  const value = propertyFirst.exec(html)?.[1] ?? contentFirst.exec(html)?.[1];
  return value === undefined ? null : htmlText(value);
}

async function fetchEmbedPage(id: string, offset: number): Promise<string> {
  const url = new URL(`https://open.spotify.com/embed/playlist/${id}`);
  if (offset > 0) url.searchParams.set('offset', String(offset));
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'discord-music-platform/0.1' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.text();
}

function pageSignature(tracks: readonly SpotifyTrackMeta[]): string {
  return tracks.map((track) => `${track.title} ${track.artist}`).join('');
}

/** Serialised embed state, for a deployment that ships JSON instead of rows. */
function embedStateTracks(html: string, limit: number): RawTrack[] {
  const tracks: RawTrack[] = [];
  const scriptPattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(scriptPattern)) {
    try {
      objectTracks(JSON.parse(match[1] ?? ''), tracks, limit);
    } catch {
      // A non-state JSON script is expected on the page.
    }
    if (tracks.length >= limit) break;
  }
  return tracks;
}

/**
 * Public embed fallback. The embed is an official, unauthenticated Spotify
 * page and supplies metadata only; audio still comes from Lavalink searches.
 * Only the first page is fetched up front — the rest arrives through `more()`.
 */
async function publicPlaylist(id: string): Promise<SpotifyResolution> {
  const limit = playlistTrackLimit();

  let html: string;
  try {
    html = await fetchEmbedPage(id, 0);
  } catch (error) {
    logger.debug({ err: error, id }, 'Public Spotify playlist fallback failed');
    throw new ValidationError('That Spotify playlist is private or inaccessible.');
  }

  const artwork = metaContent(html, 'og:image');
  const collectionName = metaContent(html, 'og:title');
  const firstPage = embedTracks(html, limit, artwork);

  if (firstPage.length === 0) {
    const stateTracks = embedStateTracks(html, limit);
    if (stateTracks.length === 0) {
      throw new ValidationError(
        "I couldn't retrieve the public track list for that Spotify playlist right now.",
      );
    }
    return {
      tracks: stateTracks.slice(0, limit).map((track) => toMeta(track, artwork)),
      collectionName,
    };
  }

  // A short first page means the embed rendered the whole public track list.
  if (firstPage.length < 50 || firstPage.length >= limit) {
    return { tracks: firstPage, collectionName };
  }

  return {
    tracks: firstPage,
    collectionName,
    // Offsets must still be walked one at a time: the embed exposes no total,
    // so a short or repeated page is the only stop condition. This now runs
    // after playback has started, so the walk is off the critical path.
    more: async () => {
      const collected: SpotifyTrackMeta[] = [];
      let lastPageSignature = pageSignature(firstPage);
      let offset = firstPage.length;

      while (firstPage.length + collected.length < limit) {
        let page: string;
        try {
          page = await fetchEmbedPage(id, offset);
        } catch (error) {
          logger.debug({ err: error, id, offset }, 'Public Spotify playlist expansion stopped');
          break;
        }
        const rendered = embedTracks(
          page,
          limit - firstPage.length - collected.length,
          metaContent(page, 'og:image') ?? artwork,
        );
        const signature = pageSignature(rendered);
        // An embed deployment that ignores `offset` repeats itself; stop rather
        // than queue the same tracks twice.
        if (rendered.length === 0 || signature === lastPageSignature) break;

        collected.push(...rendered);
        lastPageSignature = signature;
        offset += rendered.length;
        // A short page means the rest of the public list was rendered.
        if (rendered.length < 50) break;
      }
      return collected;
    },
  };
}

/** Resolve any supported Spotify URL into track metadata. */
export async function resolveSpotifyUrl(
  url: string,
  discordId: string,
  spotify: SpotifyService,
): Promise<SpotifyResolution> {
  const match = URL_PATTERN.exec(url);
  if (match === null) throw new ValidationError('Unsupported Spotify link.');
  const [, kind, id] = match as unknown as [string, string, string];

  const token = await spotify.accessTokenForPlayback(discordId);
  // A linked user reads through their own token; everyone else gets the app
  // token, which covers the public catalogue but not playlist items.
  const get = async <T>(path: string): Promise<T> =>
    token === null ? catalogueGet<T>(path) : apiGet<T>(path, token);

  switch (kind) {
    case 'track': {
      const track = await get<RawTrack>(`/tracks/${id}`);
      return { tracks: [toMeta(track)], collectionName: null };
    }
    case 'album': {
      const limit = playlistTrackLimit();
      const tracksPath = (offset: number): string =>
        `/albums/${id}/tracks?limit=${String(ALBUM_PAGE_SIZE)}&offset=${String(offset)}`;

      interface AlbumPage {
        readonly items: RawTrack[];
        readonly total?: number;
      }
      // Album metadata and its first track page are independent lookups.
      const [album, firstPage] = await Promise.all([
        get<{ name: string; images?: { url: string }[] }>(`/albums/${id}`),
        get<AlbumPage>(tracksPath(0)),
      ]);

      const artwork = album.images?.[0]?.url ?? null;
      const first = firstPage.items.slice(0, limit);
      const total = Math.min(firstPage.total ?? first.length, limit);
      const tailOffsets: number[] = [];
      for (let offset = ALBUM_PAGE_SIZE; offset < total; offset += ALBUM_PAGE_SIZE) {
        tailOffsets.push(offset);
      }

      return {
        tracks: first.map((track) => toMeta(track, artwork)),
        collectionName: album.name,
        more:
          tailOffsets.length === 0
            ? undefined
            : async () => {
                const pages = await mapBounded(tailOffsets, PAGE_CONCURRENCY, (offset) =>
                  get<AlbumPage>(tracksPath(offset)),
                );
                return pages
                  .flatMap((page) => page.items)
                  .slice(0, Math.max(0, limit - first.length))
                  .map((track) => toMeta(track, artwork));
              },
      };
    }
    case 'playlist': {
      if (token === null) return publicPlaylist(id);
      try {
        return await linkedPlaylist(id, token);
      } catch (error) {
        // Since February 2026 Spotify only returns playlist items to an owner
        // or collaborator. A linked listener can still play a public playlist
        // through the same no-login public metadata fallback as anyone else.
        if (error instanceof ValidationError) return publicPlaylist(id);
        throw error;
      }
    }
    case 'artist': {
      const artist = await get<{ name: string }>(`/artists/${id}`);
      // `/artists/{id}/top-tracks` was removed in February 2026. Search is
      // capped at ten results, which is exactly the size we present here.
      const top = await get<{ tracks: { items: RawTrack[] } }>(
        `/search?type=track&limit=10&q=${encodeURIComponent(`artist:${artist.name}`)}`,
      );
      return {
        tracks: top.tracks.items.slice(0, ARTIST_TRACK_LIMIT).map((track) => toMeta(track)),
        collectionName: `${artist.name} — top tracks`,
      };
    }
    default:
      throw new ValidationError('Unsupported Spotify link.');
  }
}

/**
 * The Spotify page for a recording we are playing from somewhere else.
 *
 * Purely for the "listen on" links — this never feeds playback, because Spotify
 * audio cannot be streamed. Returns null when Spotify is unconfigured or has
 * nothing matching, so a missing link is never an error.
 */
export async function searchSpotifyTrack(title: string, artist: string): Promise<string | null> {
  if (!isSpotifyConfigured()) return null;

  const query = encodeURIComponent(`${title} ${artist}`.trim());
  try {
    const page = await catalogueGet<{
      readonly tracks?: {
        readonly items?: readonly { readonly external_urls?: { readonly spotify?: string } }[];
      };
    }>(`/search?q=${query}&type=track&limit=1`);
    return page.tracks?.items?.[0]?.external_urls?.spotify ?? null;
  } catch (error) {
    logger.debug({ err: error, title }, 'Spotify link lookup failed');
    return null;
  }
}

/** The search string most likely to find the same recording elsewhere. */
export function searchQueryFor(meta: SpotifyTrackMeta): string {
  logger.debug({ title: meta.title, artist: meta.artist }, 'Spotify → search');
  return `${meta.title} ${meta.artist}`;
}

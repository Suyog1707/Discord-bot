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
import {
  rankSpotifyResults,
  searchSpotifySuggestions as sharedSpotifySuggestions,
  spotifyApiGet,
  spotifyAppToken,
  spotifyTrack,
  UpstreamError,
  ValidationError,
  type SpotifyCredentials,
  type SpotifySearchHit,
  type SpotifySearchKind,
  type SpotifySearchPage,
} from '@discord-music/shared';

import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { SpotifyService } from '../services/spotify-service.js';

const logger = getLogger('spotify');

const ARTIST_TRACK_LIMIT = 10;

const URL_PATTERN =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/u;

export interface SpotifyTrackMeta {
  readonly title: string;
  readonly artist: string;
  readonly durationMs: number;
  readonly artworkUrl: string | null;
  readonly isrc: string | null;
  /**
   * Album name, when the source supplies one. A weak but real matching signal:
   * a soundtrack album name appearing in a YouTube channel or title is
   * evidence the upload is the release rather than a scene from the film.
   * Null for the public-embed fallback, which renders no album names.
   */
  readonly album: string | null;
  /**
   * Canonical Spotify identity. This — not the playback provider's page — is
   * what the listener sees everywhere a Spotify-originated track is shown.
   * Null only for the public-embed fallback, which renders no track ids.
   */
  readonly spotifyId: string | null;
  readonly spotifyUrl: string | null;
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
  /**
   * The source could not hand over the whole playlist. Only the public embed
   * sets this: it returns one 100-track page and ignores `offset` entirely, so
   * the rest of a longer playlist is unreachable without user authorisation.
   */
  readonly truncated?: boolean;
}

/** First-page size for paged collections; also Spotify's own page maximum. */
const PLAYLIST_PAGE_SIZE = 50;
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

export type { SpotifySearchHit, SpotifySearchKind, SpotifySearchPage };
export { rankSpotifyResults };

/**
 * This deployment's Spotify app credentials.
 *
 * Read here and passed down rather than reached for inside the shared search:
 * the command router has its own environment and its own copy of these, and a
 * shared module that read one app's config would be wrong for the other.
 */
function spotifyCredentials(): SpotifyCredentials {
  const env = getEnv();
  if (env.SPOTIFY_CLIENT_ID === undefined || env.SPOTIFY_CLIENT_SECRET === undefined) {
    throw new UpstreamError(
      'Spotify links need SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET configured.',
    );
  }
  return { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET };
}

export function isSpotifyConfigured(): boolean {
  const env = getEnv();
  return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
}

function playlistTrackLimit(): number {
  return getEnv().SPOTIFY_PLAYLIST_MAX_TRACKS;
}

async function catalogueGet<T>(path: string): Promise<T> {
  return spotifyApiGet<T>(path, await spotifyAppToken(spotifyCredentials()));
}

interface RawTrack {
  readonly id?: string;
  readonly name: string;
  readonly duration_ms: number;
  /** Absent on podcast episodes, which a playlist is allowed to contain. */
  readonly artists?: readonly { readonly name: string }[];
  readonly album?: {
    readonly name?: string;
    readonly images?: readonly { readonly url: string }[];
  };
  readonly external_ids?: { readonly isrc?: string };
  readonly external_urls?: { readonly spotify?: string };
  /** `spotify:track:<id>` — how the embed's state JSON identifies a track. */
  readonly uri?: string;
  readonly is_local?: boolean;
}

/** The track id, from whichever field this payload carries it in. */
function spotifyIdOf(track: RawTrack): string | null {
  if (track.id !== undefined && track.id.length > 0) return track.id;
  const fromUri = /^spotify:track:([A-Za-z0-9]+)$/u.exec(track.uri ?? '');
  return fromUri?.[1] ?? null;
}

function toMeta(track: RawTrack, artworkFallback: string | null = null): SpotifyTrackMeta {
  const spotifyId = spotifyIdOf(track);
  return {
    title: track.name,
    artist: (track.artists ?? []).map((artist) => artist.name).join(', '),
    durationMs: track.duration_ms,
    artworkUrl: track.album?.images?.[0]?.url ?? artworkFallback,
    isrc: track.external_ids?.isrc ?? null,
    album: track.album?.name ?? null,
    spotifyId,
    spotifyUrl:
      track.external_urls?.spotify ??
      (spotifyId === null ? null : `https://open.spotify.com/track/${spotifyId}`),
  };
}

interface PlaylistPage {
  /**
   * Spotify names the entry's payload `track`. `item` is tolerated because an
   * earlier revision of this file asked for that key and it costs nothing to
   * accept both rather than silently drop every row if it ever comes back.
   */
  readonly items?: readonly ({
    readonly track?: RawTrack | null;
    readonly item?: RawTrack | null;
  } | null)[];
  readonly next: string | null;
  readonly total?: number;
}

function playablePlaylistTracks(page: PlaylistPage): RawTrack[] {
  if (page.items === undefined) {
    // Spotify returns playlist metadata but deliberately omits items for
    // playlists that the token holder does not own/collaborate on.
    throw new ValidationError('Spotify did not provide items for that playlist.');
  }
  return page.items.flatMap((entry) => {
    const track = spotifyTrack(entry);
    // A playlist may hold podcast episodes and local files. Neither carries the
    // artist list `toMeta` needs, and neither is playable from a search.
    if (track == null || track.is_local === true || track.artists === undefined) return [];
    return [track];
  });
}

async function linkedPlaylist(id: string, token: string): Promise<SpotifyResolution> {
  const limit = playlistTrackLimit();
  // Current Development Mode playlist endpoint; responses tolerate legacy keys.
  const itemsPath = (offset: number): string =>
    `/playlists/${id}/items?limit=${String(PLAYLIST_PAGE_SIZE)}&offset=${String(offset)}`;

  // Name and first page are independent lookups — no reason to serialise them.
  const [playlist, firstPage] = await Promise.all([
    spotifyApiGet<{ readonly name: string }>(`/playlists/${id}?fields=name`, token),
    spotifyApiGet<PlaylistPage>(itemsPath(0), token),
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
              spotifyApiGet<PlaylistPage>(itemsPath(offset), token),
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
    tracks.push({
      title,
      artist,
      durationMs: duration,
      artworkUrl,
      isrc: null,
      // The embed renders no album name; the matcher treats null as "unknown"
      // rather than "no album", so this costs a signal and never misleads.
      album: null,
      spotifyId: null,
      spotifyUrl: null,
    });
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

/**
 * The public embed page is scraped, not called, so it keeps its own budget
 * rather than borrowing the Web API's.
 */
const EMBED_TIMEOUT_MS = 10_000;

async function fetchEmbedPage(id: string, offset: number): Promise<string> {
  const url = new URL(`https://open.spotify.com/embed/playlist/${id}`);
  if (offset > 0) url.searchParams.set('offset', String(offset));
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'discord-music-platform/0.1' },
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
      truncated: stateTracks.length >= PLAYLIST_PAGE_SIZE && stateTracks.length < limit,
    };
  }

  // A short first page means the embed rendered the whole public track list.
  if (firstPage.length < 50 || firstPage.length >= limit) {
    return {
      tracks: firstPage,
      collectionName,
      truncated: firstPage.length >= PLAYLIST_PAGE_SIZE && firstPage.length < limit,
    };
  }

  return {
    tracks: firstPage,
    collectionName,
    // A full page means Spotify capped the embed rather than reaching the end.
    // The walk below is kept in case `offset` starts working again, but as of
    // now it returns the same page every time and stops on the first repeat.
    truncated: firstPage.length >= PLAYLIST_PAGE_SIZE,
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
    token === null ? catalogueGet<T>(path) : spotifyApiGet<T>(path, token);

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

/* ---------------------------------------------------- free-text search --- */

/**
 * Match tiers, spaced far enough apart that no tiebreaker can cross tiers:
 * an exact name beats title+artist beats "all words present" beats a partial
 * overlap, no matter how popular the weaker match is.
 */

/** The single most relevant result, or null when nothing credibly matches. */
export function pickBestSpotifyResult(
  query: string,
  page: SpotifySearchPage,
): SpotifySearchHit | null {
  return rankSpotifyResults(query, page)[0] ?? null;
}

/**
 * A search result, plus the track itself when the result is a track.
 *
 * `/search` answers with whole track objects — runtime, ISRC, album and art —
 * so a free-text `/play` that lands on a track already holds everything
 * `/tracks/{id}` would return. Fetching it again cost a Spotify round trip,
 * and the linked-account database read in front of it, on every such `/play`.
 */
export interface SpotifySearchMatch extends SpotifySearchHit {
  readonly track?: SpotifyTrackMeta;
}

/** Whether a search item is a whole track, not just the slice ranking reads. */
function isWholeTrack(value: unknown): value is RawTrack {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly name?: unknown; readonly duration_ms?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.duration_ms === 'number';
}

/** {@link pickBestSpotifyResult}, keeping the matched track's own details. */
export function bestSpotifyMatch(
  query: string,
  page: SpotifySearchPage,
): SpotifySearchMatch | null {
  const best = pickBestSpotifyResult(query, page);
  if (best?.kind !== 'track') return best;

  const raw: unknown = page.tracks?.items?.find(
    (item) => item?.external_urls?.spotify === best.url,
  );
  // Without a runtime there is nothing to match playback against; fetching the
  // track properly beats guessing.
  return isWholeTrack(raw) ? { ...best, track: toMeta(raw) } : best;
}

async function searchPage(query: string): Promise<SpotifySearchPage> {
  return catalogueGet<SpotifySearchPage>(
    `/search?type=track,album,artist,playlist&limit=10&q=${encodeURIComponent(query)}`,
  );
}

/**
 * Search the Spotify catalogue for whatever `query` most plausibly names —
 * a track, an album, an artist or a playlist.
 *
 * Returns null when Spotify is unconfigured, unreachable, or has no credible
 * match, so the caller can always fall back to a plain provider search.
 */
export async function searchSpotifyBest(query: string): Promise<SpotifySearchMatch | null> {
  if (!isSpotifyConfigured()) return null;

  try {
    const best = bestSpotifyMatch(query, await searchPage(query));
    logger.debug(
      best === null
        ? { query, matched: false }
        : { query, matched: true, kind: best.kind, name: best.name },
      'Spotify free-text search',
    );
    return best;
  } catch (error) {
    logger.debug({ err: error, query }, 'Spotify free-text search failed');
    return null;
  }
}

/**
 * Ranked Spotify suggestions for search-as-you-type.
 *
 * A thin wrapper over the shared search, which the command router also calls.
 * One ranking, one dedupe, one opinion about what a good match is — the two
 * must not drift, because a suggestion's value is what actually gets played.
 */
export async function searchSpotifySuggestions(
  query: string,
): Promise<readonly SpotifySearchHit[]> {
  if (!isSpotifyConfigured()) return [];
  return sharedSpotifySuggestions(spotifyCredentials(), query);
}

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
  readonly tracks: readonly SpotifyTrackMeta[];
  /** Set for album/playlist/artist URLs. */
  readonly collectionName: string | null;
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
    throw new UpstreamError('Spotify did not respond in time. Try again shortly.', { cause: error });
  }
  if (response.status === 404) {
    throw new ValidationError('That Spotify link points at nothing (deleted or private?).');
  }
  if (response.status === 401) {
    throw new UpstreamError('Spotify authorization expired. Reconnect your Spotify account and try again.');
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
}

async function linkedPlaylist(
  id: string,
  token: string,
): Promise<SpotifyResolution> {
  const playlist = await apiGet<{ readonly name: string }>(`/playlists/${id}?fields=name`, token);
  const tracks: RawTrack[] = [];
  const limit = playlistTrackLimit();
  let path: string | null =
    `/playlists/${id}/items?limit=100&fields=items(item(name,duration_ms,artists(name),album(images),external_ids,is_local)),next`;

  while (path !== null && tracks.length < limit) {
    const page: PlaylistPage = await apiGet<PlaylistPage>(path, token);
    if (page.items === undefined) {
      // Spotify returns playlist metadata but deliberately omits items for
      // playlists that the token holder does not own/collaborate on.
      throw new ValidationError('Spotify did not provide items for that playlist.');
    }
    for (const entry of page.items) {
      if (entry.item !== null && entry.item.is_local !== true) tracks.push(entry.item);
      if (tracks.length >= limit) break;
    }
    path = page.next;
  }
  return { tracks: tracks.map((track) => toMeta(track)), collectionName: playlist.name };
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
    artists.every((artist) => artist !== null && typeof artist === 'object' && typeof (artist as { name?: unknown }).name === 'string')
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
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/giu, (_match, hex: string | undefined, decimal: string | undefined) =>
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
  const pattern = /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]{0,2000}?<h4[^>]*>([\s\S]*?)<\/h4>[\s\S]{0,2000}?\b(\d{1,2}:\d{2})\b/giu;
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

/**
 * Public embed fallback. The embed is an official, unauthenticated Spotify
 * page and supplies metadata only; audio still comes from Lavalink searches.
 */
async function publicPlaylist(id: string): Promise<SpotifyResolution> {
  const limit = playlistTrackLimit();
  const collected: SpotifyTrackMeta[] = [];
  let collectionName: string | null = null;
  let lastPageSignature: string | null = null;
  let offset = 0;

  // The official embed currently renders a page of tracks. Request successive
  // offsets when Spotify exposes them; if an embed deployment ignores offset,
  // its repeated page signature ends expansion without duplicating tracks.
  while (collected.length < limit) {
    let html: string;
    try {
      const url = new URL(`https://open.spotify.com/embed/playlist/${id}`);
      if (offset > 0) url.searchParams.set('offset', String(offset));
      const response = await fetch(url, {
        headers: { Accept: 'text/html', 'User-Agent': 'discord-music-platform/0.1' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        if (collected.length > 0) break;
        throw new Error(`HTTP ${String(response.status)}`);
      }
      html = await response.text();
    } catch (error) {
      logger.debug({ err: error, id, offset }, 'Public Spotify playlist fallback failed');
      if (collected.length > 0) break;
      throw new ValidationError('That Spotify playlist is private or inaccessible.');
    }

    const artwork = metaContent(html, 'og:image');
    collectionName ??= metaContent(html, 'og:title');
    const renderedTracks = embedTracks(html, limit - collected.length, artwork);
    const signature = renderedTracks.map((track) => `${track.title}\u0000${track.artist}`).join('\u0001');
    if (renderedTracks.length === 0 || signature === lastPageSignature) {
      if (collected.length > 0) break;
      // Keep this tolerant of an embed deployment that supplies serialised
      // state instead of rendered rows, without relying on a wrapper name.
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
      if (tracks.length === 0) {
        throw new ValidationError(
          "I couldn't retrieve the public track list for that Spotify playlist right now.",
        );
      }
      return {
        tracks: tracks.slice(0, limit).map((track) => toMeta(track, artwork)),
        collectionName,
      };
    }

    collected.push(...renderedTracks);
    lastPageSignature = signature;
    offset += renderedTracks.length;
    // A short page means the entire public track list was rendered.
    if (renderedTracks.length < 50) break;
  }

  return { tracks: collected, collectionName };
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

  switch (kind) {
    case 'track': {
      const token = await spotify.accessTokenForPlayback(discordId);
      const track = await (token === null
        ? catalogueGet<RawTrack>(`/tracks/${id}`)
        : apiGet<RawTrack>(`/tracks/${id}`, token));
      return { tracks: [toMeta(track)], collectionName: null };
    }
    case 'album': {
      const token = await spotify.accessTokenForPlayback(discordId);
      const album = await (token === null
        ? catalogueGet<{
            name: string;
            images?: { url: string }[];
          }>(`/albums/${id}`)
        : apiGet<{
        name: string;
        images?: { url: string }[];
          }>(`/albums/${id}`, token));
      const tracks: RawTrack[] = [];
      const limit = playlistTrackLimit();
      let path: string | null = `/albums/${id}/tracks?limit=50`;
      while (path !== null && tracks.length < limit) {
        const page: { readonly items: RawTrack[]; readonly next: string | null } = await (token === null
          ? catalogueGet<{ items: RawTrack[]; next: string | null }>(path)
          : apiGet<{ items: RawTrack[]; next: string | null }>(path, token));
        tracks.push(...page.items.slice(0, limit - tracks.length));
        path = page.next;
      }
      const artwork = album.images?.[0]?.url ?? null;
      return {
        tracks: tracks.map((track) => toMeta(track, artwork)),
        collectionName: album.name,
      };
    }
    case 'playlist': {
      const token = await spotify.accessTokenForPlayback(discordId);
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
      const token = await spotify.accessTokenForPlayback(discordId);
      async function artistGet<T>(path: string): Promise<T> {
        return token === null ? catalogueGet<T>(path) : apiGet<T>(path, token);
      }
      const artist = await artistGet<{ name: string }>(`/artists/${id}`);
      // `/artists/{id}/top-tracks` was removed in February 2026. Search is
      // capped at ten results, which is exactly the size we present here.
      const top = await artistGet<{ tracks: { items: RawTrack[] } }>(
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

/** The search string most likely to find the same recording elsewhere. */
export function searchQueryFor(meta: SpotifyTrackMeta): string {
  logger.debug({ title: meta.title, artist: meta.artist }, 'Spotify → search');
  return `${meta.title} ${meta.artist}`;
}

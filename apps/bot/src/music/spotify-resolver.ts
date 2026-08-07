/**
 * Spotify URL support: metadata from the Web API, audio from the configured
 * playback sources. Spotify audio is never streamed — a track/album/playlist/
 * artist URL resolves to metadata, and each track then finds its best
 * playable match through Lavalink search (`title artist`).
 *
 * Uses the client-credentials flow (app token, no user context), cached until
 * shortly before expiry. Inert unless SPOTIFY_CLIENT_ID/SECRET are set.
 */
import { UpstreamError, ValidationError } from '@discord-music/shared';

import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('spotify');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const TIMEOUT_MS = 10_000;
/** Cap for album/playlist/artist expansions — resolution is one search each. */
const MAX_TRACKS = 50;

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

export function isSpotifyConfigured(): boolean {
  const env = getEnv();
  return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
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

async function apiGet<T>(path: string): Promise<T> {
  const token = await appToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new ValidationError('That Spotify link points at nothing (deleted or private?).');
  }
  if (!response.ok) {
    throw new UpstreamError(`Spotify lookup failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
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

/** Resolve any supported Spotify URL into track metadata. */
export async function resolveSpotifyUrl(url: string): Promise<SpotifyResolution> {
  const match = URL_PATTERN.exec(url);
  if (match === null) throw new ValidationError('Unsupported Spotify link.');
  const [, kind, id] = match as unknown as [string, string, string];

  switch (kind) {
    case 'track': {
      const track = await apiGet<RawTrack>(`/tracks/${id}`);
      return { tracks: [toMeta(track)], collectionName: null };
    }
    case 'album': {
      const album = await apiGet<{
        name: string;
        images?: { url: string }[];
        tracks: { items: RawTrack[] };
      }>(`/albums/${id}`);
      const artwork = album.images?.[0]?.url ?? null;
      return {
        tracks: album.tracks.items.slice(0, MAX_TRACKS).map((track) => toMeta(track, artwork)),
        collectionName: album.name,
      };
    }
    case 'playlist': {
      const playlist = await apiGet<{
        name: string;
        tracks: { items: { track: RawTrack | null }[] };
      }>(
        `/playlists/${id}?fields=name,tracks.items(track(name,duration_ms,artists(name),album(images),external_ids,is_local))`,
      );
      const tracks = playlist.tracks.items
        .flatMap((item) =>
          item.track === null || item.track.is_local === true ? [] : [item.track],
        )
        .slice(0, MAX_TRACKS)
        .map((track) => toMeta(track));
      return { tracks, collectionName: playlist.name };
    }
    case 'artist': {
      const top = await apiGet<{ tracks: RawTrack[] }>(`/artists/${id}/top-tracks?market=US`);
      const artist = await apiGet<{ name: string }>(`/artists/${id}`);
      return {
        tracks: top.tracks.slice(0, 10).map((track) => toMeta(track)),
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

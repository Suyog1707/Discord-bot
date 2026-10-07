import 'server-only';

/**
 * Thin Spotify Web API client: OAuth endpoints, token exchange/refresh, and
 * the read calls the import feature needs. All functions are inert unless
 * SPOTIFY_CLIENT_ID/SECRET are configured — callers gate on
 * `isSpotifyConfigured()` and surface a clear message otherwise.
 */
import {
  UpstreamError,
  spotifyTrack,
  spotifyApiUrl,
  spotifyRequestError,
} from '@discord-music/shared';

import { getEnv } from '@/lib/env';
import { publicUrl } from '@/lib/public-origin';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';

/** Read-only scopes: playlists plus (optional at use) the user's library. */
export const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';

export function isSpotifyConfigured(): boolean {
  const env = getEnv();
  return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
}

function credentials(): { id: string; secret: string } {
  const env = getEnv();
  if (env.SPOTIFY_CLIENT_ID === undefined || env.SPOTIFY_CLIENT_SECRET === undefined) {
    throw new UpstreamError(
      'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
    );
  }
  return { id: env.SPOTIFY_CLIENT_ID, secret: env.SPOTIFY_CLIENT_SECRET };
}

export function redirectUri(): string {
  const redirectUri = getEnv().SPOTIFY_REDIRECT_URI;

  if (redirectUri === undefined) {
    throw new UpstreamError('SPOTIFY_REDIRECT_URI is not configured.');
  }

  const configured = new URL(redirectUri);
  const expected = publicUrl('/api/spotify/callback');
  if (configured.href !== expected.href) {
    throw new UpstreamError(
      'SPOTIFY_REDIRECT_URI must match the public website /api/spotify/callback URL.',
    );
  }
  return configured.href;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: credentials().id,
    scope: SPOTIFY_SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

export interface SpotifyTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly scopes: string;
}

async function tokenRequest(body: URLSearchParams): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}> {
  const { id, secret } = credentials();
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();

  if (!response.ok) {
    console.error('Spotify token request failed:', {
      status: response.status,
    });

    throw new UpstreamError(`Spotify token request failed (${String(response.status)}).`);
  }

  return JSON.parse(responseText) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
}

export async function exchangeCode(code: string): Promise<SpotifyTokens> {
  const data = await tokenRequest(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
  );
  if (data.refresh_token === undefined) {
    throw new UpstreamError('Spotify did not return a refresh token.');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope ?? SPOTIFY_SCOPES,
  };
}

export async function refreshTokens(refreshToken: string): Promise<SpotifyTokens> {
  const data = await tokenRequest(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
  return {
    accessToken: data.access_token,
    // Spotify usually keeps the refresh token; rotate when it sends a new one.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope ?? SPOTIFY_SCOPES,
  };
}

/* ------------------------------------------------------------- API reads */

async function apiGet<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(spotifyApiUrl(path.startsWith('/') ? `/v1${path}` : path), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();

  if (!response.ok) {
    console.error('Spotify API request failed:', {
      status: response.status,
    });

    throw spotifyRequestError(response.status, response.headers.get('retry-after'));
  }

  return JSON.parse(responseText) as T;
}

export interface SpotifyProfile {
  readonly id: string;
  readonly display_name: string | null;
  readonly country?: string;
}

export function getProfile(accessToken: string): Promise<SpotifyProfile> {
  return apiGet(accessToken, '/me');
}

export interface SpotifyPlaylistSummary {
  readonly id: string;
  readonly name: string;
  readonly snapshot_id: string;
  readonly tracks?: { readonly total: number } | null;
  readonly items?: { readonly total: number } | null;
  readonly owner: { readonly display_name: string | null } | null;
  readonly public: boolean | null;
}

export async function listPlaylists(
  accessToken: string,
): Promise<readonly SpotifyPlaylistSummary[]> {
  const collected: SpotifyPlaylistSummary[] = [];
  let url: string | null = '/me/playlists?limit=50';
  const seen = new Set<string>();
  while (url !== null && collected.length < 200) {
    if (seen.has(url)) throw new UpstreamError('Spotify returned repeated playlist pages.');
    seen.add(url);
    const page: { items: (SpotifyPlaylistSummary | null)[]; next: string | null } = await apiGet(
      accessToken,
      url,
    );
    collected.push(...page.items.filter((item): item is SpotifyPlaylistSummary => item !== null));
    url = page.next;
  }
  return collected.slice(0, 200);
}

export interface SpotifyTrack {
  readonly id: string | null;
  readonly name: string;
  readonly duration_ms: number;
  readonly artists: readonly { readonly name: string }[];
  readonly album?: { readonly images?: readonly { readonly url: string }[] };
  readonly external_urls?: { readonly spotify?: string };
  readonly is_local?: boolean;
}

/** Fetch every track of a playlist (paginated), skipping local files. */
export async function getPlaylistTracks(
  accessToken: string,
  playlistId: string,
  limit: number,
): Promise<readonly SpotifyTrack[]> {
  const collected: SpotifyTrack[] = [];
  let url: string | null = `/playlists/${encodeURIComponent(playlistId)}/items?limit=50`;
  const seen = new Set<string>();
  while (url !== null && collected.length < limit) {
    if (seen.has(url)) throw new UpstreamError('Spotify returned repeated track pages.');
    seen.add(url);
    const page: {
      items: ({ track?: SpotifyTrack | null; item?: SpotifyTrack | null } | null)[];
      next: string | null;
    } = await apiGet(accessToken, url);
    if (!Array.isArray(page.items))
      throw new UpstreamError(
        'Spotify did not provide playlist tracks. You may need to own or collaborate on this playlist.',
      );
    for (const item of page.items) {
      const track = spotifyTrack(item);
      if (
        track !== null &&
        track.is_local !== true &&
        track.id !== null &&
        Array.isArray(track.artists) &&
        typeof track.duration_ms === 'number'
      ) {
        collected.push(track);
      }
    }
    url = page.next;
  }
  return collected.slice(0, limit);
}

export async function getPlaylistMeta(
  accessToken: string,
  playlistId: string,
): Promise<SpotifyPlaylistSummary> {
  return apiGet(accessToken, `/playlists/${encodeURIComponent(playlistId)}`);
}

/** The user's Liked Songs (requires user-library-read). */
export async function getSavedTracks(
  accessToken: string,
  limit: number,
): Promise<readonly SpotifyTrack[]> {
  const collected: SpotifyTrack[] = [];
  let url: string | null = '/me/tracks?limit=50';
  const seen = new Set<string>();
  while (url !== null && collected.length < limit) {
    if (seen.has(url)) throw new UpstreamError('Spotify returned repeated saved-track pages.');
    seen.add(url);
    const page: {
      items: ({ track?: SpotifyTrack | null; item?: SpotifyTrack | null } | null)[];
      next: string | null;
    } = await apiGet(accessToken, url);
    for (const entry of page.items) {
      const track = spotifyTrack(entry);
      if (
        track !== null &&
        track.is_local !== true &&
        track.id !== null &&
        Array.isArray(track.artists) &&
        typeof track.duration_ms === 'number'
      )
        collected.push(track);
    }
    url = page.next;
  }
  return collected.slice(0, limit);
}

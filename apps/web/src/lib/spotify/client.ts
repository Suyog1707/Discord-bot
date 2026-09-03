import 'server-only';

/**
 * Thin Spotify Web API client: OAuth endpoints, token exchange/refresh, and
 * the read calls the import feature needs. All functions are inert unless
 * SPOTIFY_CLIENT_ID/SECRET are configured — callers gate on
 * `isSpotifyConfigured()` and surface a clear message otherwise.
 */
import { UpstreamError } from '@discord-music/shared';

import { getEnv } from '@/lib/env';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

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

  return redirectUri;
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
    let spotifyError: unknown = responseText;

    try {
      spotifyError = JSON.parse(responseText);
    } catch {
      // Keep the raw response text.
    }

    console.error('Spotify token request failed:', {
      status: response.status,
      response: spotifyError,
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
  const response = await fetch(path.startsWith('https://') ? path : `${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();

  if (!response.ok) {
    let spotifyError: unknown = responseText;

    try {
      spotifyError = JSON.parse(responseText);
    } catch {
      // Keep the raw response text.
    }

    console.error('Spotify API request failed:', {
      status: response.status,
      response: spotifyError,
      path,
    });

    throw new UpstreamError(`Spotify API request failed (${String(response.status)}).`);
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
  readonly tracks: { readonly total: number };
  readonly owner: { readonly display_name: string | null };
  readonly public: boolean | null;
}

export async function listPlaylists(
  accessToken: string,
): Promise<readonly SpotifyPlaylistSummary[]> {
  const collected: SpotifyPlaylistSummary[] = [];
  let url: string | null = '/me/playlists?limit=50';
  while (url !== null && collected.length < 200) {
    const page: { items: SpotifyPlaylistSummary[]; next: string | null } = await apiGet(
      accessToken,
      url,
    );
    collected.push(...page.items);
    url = page.next;
  }
  return collected;
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
  let url: string | null = `/playlists/${playlistId}/tracks?limit=100`;
  while (url !== null && collected.length < limit) {
    const page: { items: { track: SpotifyTrack | null }[]; next: string | null } = await apiGet(
      accessToken,
      url,
    );
    for (const item of page.items) {
      if (item.track !== null && item.track.is_local !== true && item.track.id !== null) {
        collected.push(item.track);
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
  return apiGet(
    accessToken,
    `/playlists/${playlistId}?fields=id,name,snapshot_id,tracks(total),owner(display_name),public`,
  );
}

/** The user's Liked Songs (requires user-library-read). */
export async function getSavedTracks(
  accessToken: string,
  limit: number,
): Promise<readonly SpotifyTrack[]> {
  const collected: SpotifyTrack[] = [];
  let url: string | null = '/me/tracks?limit=50';
  while (url !== null && collected.length < limit) {
    const page: { items: { track: SpotifyTrack }[]; next: string | null } = await apiGet(
      accessToken,
      url,
    );
    collected.push(...page.items.map((item) => item.track));
    url = page.next;
  }
  return collected.slice(0, limit);
}

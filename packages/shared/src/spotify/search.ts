/**
 * Spotify's catalogue search, and the ranking that makes it useful.
 *
 * Lifted out of the bot so the command router can use it too. Autocomplete is
 * the one interaction with no deferral to hide behind — it must answer inside
 * three seconds, in the HTTP response itself — so it cannot be handed to a bot
 * and has to be answered where Discord's request lands. Both sides now share
 * one implementation rather than growing a second opinion about what a good
 * match is.
 *
 * Credentials are passed in rather than read from an environment, because the
 * two callers have different ones to read. The token cache is module-level and
 * so per-process, which is exactly what it was before the move.
 */
import { UpstreamError, ValidationError } from '../errors/index.js';

export interface SpotifyCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const API_BASE = 'https://api.spotify.com/v1';

const TIMEOUT_MS = 10_000;

/** One process, one app token. */
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function spotifyAppToken(credentials: SpotifyCredentials): Promise<string> {
  if (cachedToken !== null && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.value;
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      // `btoa` rather than `Buffer`: this module is reachable from the
      // isomorphic barrel, and Node has had `btoa` since 16.
      Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
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

export async function spotifyApiGet<T>(path: string, token: string): Promise<T> {
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

export type SpotifySearchKind = 'track' | 'album' | 'artist' | 'playlist';

/** The winner of a ranked Spotify search — always addressed by its own URL. */
export interface SpotifySearchHit {
  readonly kind: SpotifySearchKind;
  readonly url: string;
  readonly name: string;
  readonly artist: string | null;
}

/** The slice of a `/search` response the ranking needs. */
export interface SpotifySearchPage {
  readonly tracks?: {
    readonly items?: readonly ({
      readonly name?: string;
      readonly artists?: readonly { readonly name?: string }[];
      readonly popularity?: number;
      readonly external_urls?: { readonly spotify?: string };
    } | null)[];
  };
  readonly albums?: {
    readonly items?: readonly ({
      readonly name?: string;
      readonly artists?: readonly { readonly name?: string }[];
      readonly album_type?: string;
      readonly external_urls?: { readonly spotify?: string };
    } | null)[];
  };
  readonly artists?: {
    readonly items?: readonly ({
      readonly name?: string;
      readonly popularity?: number;
      readonly external_urls?: { readonly spotify?: string };
    } | null)[];
  };
  readonly playlists?: {
    readonly items?: readonly ({
      readonly name?: string;
      readonly external_urls?: { readonly spotify?: string };
    } | null)[];
  };
}

interface ScoredHit extends SpotifySearchHit {
  readonly score: number;
}

const TIER_EXACT = 400;

const TIER_TITLE_AND_ARTIST = 300;

const TIER_ALL_WORDS = 200;

const TIER_PARTIAL = 100;

/** Lowercase, punctuation to spaces, whitespace collapsed. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Score one candidate's text against the query.
 *
 * @returns The tier score, or 0 when the candidate is not a credible match.
 */
function textScore(query: string, name: string, artist: string | null): number {
  const normalisedName = normalise(name);
  if (normalisedName.length === 0) return 0;
  if (normalisedName === query) return TIER_EXACT;

  const normalisedArtist = artist === null ? '' : normalise(artist);

  // "Parwana Arijit Singh": the name covers the query's head, the artist
  // covers everything after it.
  if (normalisedArtist.length > 0 && `${query} `.startsWith(`${normalisedName} `)) {
    const rest = query.slice(normalisedName.length).trim().split(' ');
    if (rest.every((word) => normalisedArtist.includes(word))) return TIER_TITLE_AND_ARTIST;
  }

  const haystack = `${normalisedName} ${normalisedArtist}`;
  const words = query.split(' ');
  const hits = words.filter((word) => haystack.includes(word)).length;
  if (hits === words.length) return TIER_ALL_WORDS;
  const overlap = hits / words.length;
  return overlap >= 0.6 ? TIER_PARTIAL * overlap : 0;
}

/**
 * Kind preference *within* a tier. A full album named exactly what was typed
 * outranks the identically-named track — "/play Parwana" queueing the album
 * (which contains its title track anyway) is the asked-for behaviour — while
 * everywhere below the exact tier a concrete track is the safer guess.
 * Playlists rank last throughout: they are the loosest match for a bare
 * phrase and should only win when nothing better exists.
 */
function kindBonus(kind: SpotifySearchKind, albumType: string | undefined, exact: boolean): number {
  switch (kind) {
    case 'album':
      return albumType === 'album' ? (exact ? 30 : 15) : 10;
    case 'track':
      return 20;
    case 'artist':
      return exact ? 25 : 5;
    case 'playlist':
      return 0;
  }
}

/**
 * Identity of one search result for deduplication.
 *
 * Two layers, both checked: the Spotify URL (which embeds the stable Spotify
 * id — the same catalogue object surfacing through different result groups or
 * ranking paths), and a normalised name+artist key per kind, which catches the
 * same SONG published as several catalogue objects (single, album cut,
 * re-release). Bracketed asides are stripped for the song key — "(Remastered)"
 * and "(Official Video)" name the same recording — so search can never show
 * "Song — Artist" twice.
 */
function resultIdentities(hit: SpotifySearchHit): readonly string[] {
  const name = normalise(hit.name.replace(/[([{][^)\]}]*[)\]}]/gu, ' '));
  const artist = hit.artist === null ? '' : normalise(hit.artist);
  return [`url:${hit.url}`, `${hit.kind}:${name}|${artist}`];
}

/**
 * Every credible result across every kind Spotify returned, most relevant
 * first. Relevance is tiers of exactness first, kind and popularity only as
 * tiebreakers — never "blindly the first result".
 */
export function rankSpotifyResults(
  query: string,
  page: SpotifySearchPage,
): readonly SpotifySearchHit[] {
  const normalisedQuery = normalise(query);
  if (normalisedQuery.length === 0) return [];

  const scored: ScoredHit[] = [];
  const consider = (
    kind: SpotifySearchKind,
    name: string | undefined,
    artist: string | null,
    url: string | undefined,
    popularity: number,
    albumType?: string,
  ): void => {
    if (name === undefined || name.length === 0 || url === undefined) return;
    const text = textScore(normalisedQuery, name, artist);
    if (text === 0) return;
    scored.push({
      kind,
      url,
      name,
      artist,
      score:
        text + kindBonus(kind, albumType, text === TIER_EXACT) + Math.min(popularity, 100) / 100,
    });
  };

  for (const track of page.tracks?.items ?? []) {
    if (track == null) continue;
    consider(
      'track',
      track.name,
      (track.artists ?? []).map((entry) => entry.name ?? '').join(', ') || null,
      track.external_urls?.spotify,
      track.popularity ?? 0,
    );
  }
  for (const album of page.albums?.items ?? []) {
    if (album == null) continue;
    consider(
      'album',
      album.name,
      (album.artists ?? []).map((entry) => entry.name ?? '').join(', ') || null,
      album.external_urls?.spotify,
      0,
      album.album_type,
    );
  }
  for (const artist of page.artists?.items ?? []) {
    if (artist == null) continue;
    consider('artist', artist.name, null, artist.external_urls?.spotify, artist.popularity ?? 0);
  }
  for (const playlist of page.playlists?.items ?? []) {
    if (playlist == null) continue;
    consider('playlist', playlist.name, null, playlist.external_urls?.spotify, 0);
  }

  scored.sort((a, b) => b.score - a.score);

  // Deduplicate AFTER ranking, so the survivor of each duplicate group is the
  // most relevant (and, via the popularity tiebreak, most official) version —
  // never merely the first one the API happened to return.
  const seen = new Set<string>();
  const unique: SpotifySearchHit[] = [];
  for (const { score: _score, ...hit } of scored) {
    const identities = resultIdentities(hit);
    if (identities.some((identity) => seen.has(identity))) continue;
    for (const identity of identities) seen.add(identity);
    unique.push(hit);
  }
  return unique;
}

/**
 * Ranked suggestions for search-as-you-type.
 *
 * Empty on any failure — autocomplete is decoration, and every command that
 * uses it accepts the raw text anyway.
 */
export async function searchSpotifySuggestions(
  credentials: SpotifyCredentials,
  query: string,
): Promise<readonly SpotifySearchHit[]> {
  try {
    const page = await spotifyApiGet<SpotifySearchPage>(
      `/search?type=track,album,artist,playlist&limit=10&q=${encodeURIComponent(query)}`,
      await spotifyAppToken(credentials),
    );
    return rankSpotifyResults(query, page);
  } catch {
    return [];
  }
}

/** Discord caps a choice's name and value at 100 characters. */
function clip(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const KIND_LABEL: Record<SpotifySearchKind, string> = {
  track: '🎵',
  album: '💿',
  artist: '👤',
  playlist: '📃',
};

/**
 * Suggestions as Discord wants them.
 *
 * The value is the Spotify URL, and that matters more than it looks: what a
 * suggestion carries is what actually gets played. When these were YouTube
 * results, every tapped suggestion quietly bypassed the Spotify-first pipeline
 * — YouTube search, YouTube link, no Spotify identity anywhere.
 *
 * Artists are dropped: a bare artist is ambiguous about what would play, so it
 * stays out of the list even though typed free text can still resolve to one.
 */
export function toAutocompleteChoices(
  hits: readonly SpotifySearchHit[],
): { readonly name: string; readonly value: string }[] {
  return hits
    .filter((hit) => hit.kind !== 'artist' && hit.url.length <= 100)
    .slice(0, 10)
    .map((hit) => ({
      name: clip(
        `${KIND_LABEL[hit.kind]} ${hit.name}${hit.artist === null ? '' : ` — ${hit.artist}`}`,
      ),
      value: hit.url,
    }));
}

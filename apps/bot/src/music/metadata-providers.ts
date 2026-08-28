/**
 * Metadata providers: Apple Music and Deezer.
 *
 * These identify recordings. They never supply audio — both catalogues are
 * DRM-protected and cannot be streamed by anyone, which is an upstream fact
 * rather than a limitation of this bot. What they are for is answering "what
 * exact song is this?" precisely enough that the playback layer can be held to
 * it.
 *
 * Spotify is the third member of this layer and lives in `spotify-resolver.ts`,
 * where it already was: it carries URL handling, OAuth and playlist paging that
 * has nothing to do with the other two. This module is what makes the layer a
 * layer rather than a single vendor — when Spotify is unconfigured, unreachable
 * or simply has no match, the identity question still gets an answer instead of
 * silently degrading to "whatever a search returns".
 *
 * Both APIs here are keyless and public. Deezer earns its place by exposing
 * ISRCs, which neither Apple's search endpoint nor Spotify's public embed do —
 * so it doubles as the enrichment step that upgrades a track from "described"
 * to "identified".
 *
 * Every function returns null rather than throwing. A catalogue being down
 * means the next one is asked; it never means a failed command.
 */
import { canonicalTrack, normaliseIsrc, type CanonicalTrack } from './canonical-track.js';
import { requestedVariantsOf } from './candidate-matcher.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('metadata');

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const DEEZER_SEARCH = 'https://api.deezer.com/search';
const DEEZER_TRACK = 'https://api.deezer.com/track';

/** These sit in front of a user waiting on a slash command. */
const TIMEOUT_MS = 4_000;
/** Catalogue metadata for a released recording does not change. */
const CACHE_TTL_MS = 12 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 1_000;
/** Enough to rank against; more just costs bytes. */
const SEARCH_LIMIT = 5;

interface CacheEntry {
  readonly value: CanonicalTrack | null;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): { readonly hit: true; readonly value: CanonicalTrack | null } | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return { hit: true, value: entry.value };
}

function cacheSet(key: string, value: CanonicalTrack | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Fetch JSON with a deadline, returning null instead of throwing. */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ ranking */

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Penalty for a catalogue result that is a version of the song nobody asked
 * for. Large enough to demote it beneath any plain match, small enough that it
 * still wins when it is the only credible answer.
 */
const UNREQUESTED_VARIANT_PENALTY = 1;

/**
 * How well a catalogue result answers the typed query.
 *
 * Deliberately simple, and deliberately not "the first result". These endpoints
 * rank by their own popularity signals, which is how a search for a song
 * returns a compilation album containing it. Requiring the query's words to
 * actually appear in the title-plus-artist text is a low bar that the first
 * result nonetheless fails often enough to matter.
 *
 * The variant check is the expensive lesson. Searching Apple Music for
 * "Kesariya Arijit Singh" returns the Lost Frequencies remix above the original,
 * and identifying THAT as the canonical track poisons everything downstream:
 * the playback layer then does its job perfectly and finds an excellent match
 * for the wrong recording. Identity has to be right first — a wrong canonical
 * track is not something better matching can recover from.
 *
 * @returns 0 when the result is not a credible answer to the query.
 */
function relevance(
  query: string,
  title: string,
  artist: string,
  requested: ReadonlySet<string>,
): number {
  const wanted = normalise(query).split(' ').filter(Boolean);
  if (wanted.length === 0) return 0;

  const haystack = `${normalise(title)} ${normalise(artist)}`;
  const hits = wanted.filter((word) => haystack.includes(word)).length;
  const overlap = hits / wanted.length;
  if (overlap < 0.6) return 0;

  // An exact title match outranks a merely complete word overlap: "Lights" as
  // the whole title beats "Blinding Lights" when "lights" is what was typed.
  const exact = normalise(title) === normalise(query) ? 1 : 0;

  const introduced = [...requestedVariantsOf(title)].filter((mark) => !requested.has(mark));
  const penalty = introduced.length > 0 ? UNREQUESTED_VARIANT_PENALTY : 0;

  return overlap + exact - penalty;
}

function bestOf<T>(
  query: string,
  items: readonly T[],
  describe: (item: T) => { readonly title: string; readonly artist: string },
): T | null {
  // Read once: the query does not change across candidates, and this runs per
  // result on every lookup.
  const requested = requestedVariantsOf(query);

  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const { title, artist } = describe(item);
    const score = relevance(query, title, artist, requested);
    if (score <= 0) continue;
    if (best === null || score > best.score) best = { item, score };
  }
  return best?.item ?? null;
}

/* -------------------------------------------------------------- apple music */

interface ItunesSong {
  readonly trackId?: number;
  readonly trackName?: string;
  readonly artistName?: string;
  readonly collectionName?: string;
  readonly trackTimeMillis?: number;
  readonly releaseDate?: string;
  readonly trackViewUrl?: string;
  readonly artworkUrl100?: string;
}

/**
 * Apple Music via the public iTunes Search API.
 *
 * Keyless and rate-limited rather than authenticated. It exposes a runtime, an
 * album and a release date but no ISRC, so a track identified here is a
 * candidate for the Deezer enrichment step below.
 */
export async function lookupAppleMusic(query: string): Promise<CanonicalTrack | null> {
  const key = `apple:${normalise(query)}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached.value;

  const url = new URL(ITUNES_SEARCH);
  url.searchParams.set('term', query);
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(SEARCH_LIMIT));

  const body = await fetchJson<{ readonly results?: readonly ItunesSong[] }>(url.toString());
  const song = bestOf(query, body?.results ?? [], (item) => ({
    title: item.trackName ?? '',
    artist: item.artistName ?? '',
  }));

  if (song?.trackName === undefined || song.artistName === undefined) {
    cacheSet(key, null);
    return null;
  }

  const track = canonicalTrack({
    title: song.trackName,
    artist: song.artistName,
    album: song.collectionName ?? null,
    durationMs: song.trackTimeMillis ?? 0,
    isrc: null,
    releaseDate: song.releaseDate ?? null,
    provider: 'apple-music',
    providerId: song.trackId === undefined ? null : String(song.trackId),
    url: song.trackViewUrl ?? null,
    // The search endpoint hands back a 100px thumbnail; the same path at a
    // larger size is the documented way to get artwork worth showing.
    artworkUrl: song.artworkUrl100?.replace('100x100bb', '600x600bb') ?? null,
  });
  cacheSet(key, track);
  return track;
}

/* -------------------------------------------------------------------- deezer */

interface DeezerSearchResult {
  readonly id?: number;
  readonly title?: string;
  readonly duration?: number;
  readonly link?: string;
  readonly artist?: { readonly name?: string };
  readonly album?: { readonly title?: string; readonly cover_xl?: string };
}

interface DeezerTrack extends DeezerSearchResult {
  readonly isrc?: string;
  readonly release_date?: string;
  readonly contributors?: readonly { readonly name?: string }[];
}

function deezerCanonical(track: DeezerTrack): CanonicalTrack | null {
  const title = track.title;
  const artist = track.artist?.name;
  if (title === undefined || artist === undefined) return null;

  const contributors = (track.contributors ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => name !== undefined && name.length > 0);

  return canonicalTrack({
    title,
    artist,
    // Deezer's `contributors` is the full credit list, lead first — better than
    // re-splitting the single `artist.name`, which drops collaborators entirely.
    ...(contributors.length > 0 ? { artists: contributors } : {}),
    album: track.album?.title ?? null,
    // Deezer reports whole seconds.
    durationMs: (track.duration ?? 0) * 1000,
    isrc: track.isrc ?? null,
    releaseDate: track.release_date ?? null,
    provider: 'deezer',
    providerId: track.id === undefined ? null : String(track.id),
    url: track.link ?? null,
    artworkUrl: track.album?.cover_xl ?? null,
  });
}

/**
 * Deezer via its public API.
 *
 * Two calls rather than one: `/search` ranks, `/track/{id}` is the only
 * endpoint that carries the ISRC. That second call is the whole reason Deezer
 * is in this layer, so it is not optional — an identification without the
 * strongest identifier is exactly the weaker thing this architecture replaced.
 */
export async function lookupDeezer(query: string): Promise<CanonicalTrack | null> {
  const key = `deezer:${normalise(query)}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached.value;

  const url = new URL(DEEZER_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(SEARCH_LIMIT));

  const body = await fetchJson<{ readonly data?: readonly DeezerSearchResult[] }>(url.toString());
  const hit = bestOf(query, body?.data ?? [], (item) => ({
    title: item.title ?? '',
    artist: item.artist?.name ?? '',
  }));

  if (hit?.id === undefined) {
    cacheSet(key, null);
    return null;
  }

  const full = await fetchJson<DeezerTrack>(`${DEEZER_TRACK}/${String(hit.id)}`);
  // A failed detail lookup still leaves a usable identification, just without
  // the ISRC — better than discarding a good match over one flaky request.
  const track = deezerCanonical(full ?? hit);
  cacheSet(key, track);
  return track;
}

/**
 * Fill in a missing ISRC from Deezer.
 *
 * Spotify's public playlist embed and Apple's search endpoint both describe a
 * recording without naming it, and an ISRC turns every downstream comparison
 * from "these look alike" into "these are the same master". Worth one extra
 * request for a single track; deliberately not applied per-track across a
 * collection, where it would be one round trip per song.
 *
 * The enriched ISRC is only accepted when Deezer's answer agrees with the
 * runtime we already hold — otherwise it is an ISRC for a different recording,
 * which is worse than none at all.
 */
export async function enrichIsrc(track: CanonicalTrack): Promise<CanonicalTrack> {
  if (track.isrc !== null) return track;

  const query = `${track.title} ${track.primaryArtist}`.trim();
  if (query.length === 0) return track;

  const found = await lookupDeezer(query);
  const isrc = normaliseIsrc(found?.isrc);
  if (found === null || isrc === null) return track;

  const bothTimed = track.durationMs > 0 && found.durationMs > 0;
  if (bothTimed && Math.abs(track.durationMs - found.durationMs) > 5_000) {
    logger.debug(
      { title: track.title, wantedMs: track.durationMs, deezerMs: found.durationMs },
      'ISRC enrichment refused: runtimes disagree',
    );
    return track;
  }

  return { ...track, isrc };
}

/**
 * Identify a free-text query through the non-Spotify catalogues, in order.
 *
 * Called only when Spotify could not answer — unconfigured, unreachable, or no
 * credible match — so this is the difference between "the identity layer has an
 * answer" and "fall back to searching a playback provider blind".
 */
export async function identifyCanonicalTrack(query: string): Promise<CanonicalTrack | null> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  // Deezer first of the two: it is the only one that returns an ISRC, so when
  // both would match, the identification that comes back is the stronger one.
  const deezer = await lookupDeezer(trimmed).catch((error: unknown) => {
    logger.debug({ err: error, query: trimmed }, 'Deezer identification failed');
    return null;
  });
  if (deezer !== null) return deezer;

  const apple = await lookupAppleMusic(trimmed).catch((error: unknown) => {
    logger.debug({ err: error, query: trimmed }, 'Apple Music identification failed');
    return null;
  });
  if (apple !== null) return await enrichIsrc(apple);

  return null;
}

/** Test seam: drops the memoised catalogue answers. */
export function clearMetadataCache(): void {
  cache.clear();
}

/**
 * Last.fm — the discovery signal.
 *
 * This is where "songs like this one" actually comes from. Last.fm's similarity
 * data is built from decades of real listening behaviour, which is why it is
 * used here for *candidate generation* only: it answers "what else do people who
 * play this play?", and the ranking engine downstream decides which of those
 * answers fit this particular listener. Playing Last.fm's top result directly
 * would just be someone else's taste.
 *
 * Every method returns an empty array rather than throwing. A discovery source
 * being down means fewer candidates, never a failed command — the recommender
 * has its own fallbacks (history, artist search) for exactly this case.
 */
import { getLogger } from '../lib/logger.js';

import type { CacheService } from './cache.js';

const logger = getLogger('lastfm');

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Similarity graphs barely move week to week, so these are cached hard. The
 * point of a long TTL is not saving Last.fm's bandwidth — it is that a cached
 * candidate pool is what makes a 300-track queue finish in seconds.
 */
const SIMILAR_TTL_MS = 24 * 60 * 60_000;
const TAG_TTL_MS = 7 * 24 * 60 * 60_000;

export interface SimilarTrack {
  readonly name: string;
  readonly artist: string;
  /** Last.fm's own 0–1 similarity to the seed. Feeds the similarity score. */
  readonly match: number;
}

export interface SimilarArtist {
  readonly name: string;
  readonly match: number;
}

export interface LastFmTag {
  readonly name: string;
  /** 0–100 in Last.fm's scale; normalised by the caller. */
  readonly count: number;
}

/** Shapes are declared loosely because Last.fm omits fields freely. */
interface SimilarTracksBody {
  readonly similartracks?: {
    readonly track?: readonly {
      readonly name?: string;
      readonly match?: string | number;
      readonly artist?: { readonly name?: string };
    }[];
  };
}

interface SimilarArtistsBody {
  readonly similarartists?: {
    readonly artist?: readonly { readonly name?: string; readonly match?: string | number }[];
  };
}

interface TopTagsBody {
  readonly toptags?: {
    readonly tag?: readonly { readonly name?: string; readonly count?: number }[];
  };
}

interface ArtistTopTracksBody {
  readonly toptracks?: {
    readonly track?: readonly {
      readonly name?: string;
      readonly artist?: { readonly name?: string };
    }[];
  };
}

interface TagTracksBody {
  readonly tracks?: {
    readonly track?: readonly {
      readonly name?: string;
      readonly artist?: { readonly name?: string };
    }[];
  };
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class LastFmService {
  readonly #apiKey: string | undefined;
  readonly #cache: CacheService;

  /**
   * @param apiKey - Absent disables the service entirely. Every method then
   *   returns empty, and `enabled` lets callers skip the work rather than
   *   awaiting a no-op.
   */
  constructor(cache: CacheService, apiKey?: string) {
    this.#cache = cache;
    this.#apiKey = apiKey;
  }

  get enabled(): boolean {
    return this.#apiKey !== undefined && this.#apiKey.length > 0;
  }

  /** Tracks listeners of `artist – track` also play, best match first. */
  async similarTracks(artist: string, track: string, limit = 50): Promise<readonly SimilarTrack[]> {
    const body = await this.#call<SimilarTracksBody>('track.getsimilar', {
      artist,
      track,
      limit: String(limit),
      autocorrect: '1',
    });

    return (body?.similartracks?.track ?? []).flatMap((entry) => {
      const name = entry.name;
      const artistName = entry.artist?.name;
      if (name === undefined || artistName === undefined) return [];
      return [{ name, artist: artistName, match: toNumber(entry.match) }];
    });
  }

  /** Artists adjacent to `artist`. Used to widen a pool that similar-tracks left thin. */
  async similarArtists(artist: string, limit = 30): Promise<readonly SimilarArtist[]> {
    const body = await this.#call<SimilarArtistsBody>('artist.getsimilar', {
      artist,
      limit: String(limit),
      autocorrect: '1',
    });

    return (body?.similarartists?.artist ?? []).flatMap((entry) =>
      entry.name === undefined ? [] : [{ name: entry.name, match: toNumber(entry.match) }],
    );
  }

  /**
   * Community tags for a track — genre, mood and, usefully here, language
   * ("bollywood", "hindi", "k-pop"). These are the raw material for tag affinity
   * and for the language matching that keeps a Hindi session Hindi.
   */
  async trackTags(artist: string, track: string): Promise<readonly LastFmTag[]> {
    const body = await this.#call<TopTagsBody>('track.gettoptags', {
      artist,
      track,
      autocorrect: '1',
    });
    return this.#readTags(body);
  }

  /** Tags for an artist. Falls back for tracks too obscure to be tagged themselves. */
  async artistTags(artist: string): Promise<readonly LastFmTag[]> {
    const body = await this.#call<TopTagsBody>('artist.gettoptags', { artist, autocorrect: '1' });
    return this.#readTags(body);
  }

  /**
   * Top tracks for a tag. This is how a mood or genre request from the LLM
   * ("something chill", "punjabi hip hop") becomes actual candidate songs
   * without the LLM ever naming a track itself.
   */
  async tagTopTracks(tag: string, limit = 50): Promise<readonly SimilarTrack[]> {
    const body = await this.#call<TagTracksBody>('tag.gettoptracks', {
      tag,
      limit: String(limit),
    });

    return (body?.tracks?.track ?? []).flatMap((entry) => {
      const name = entry.name;
      const artistName = entry.artist?.name;
      if (name === undefined || artistName === undefined) return [];
      // Tag charts carry no per-track match; treat them as a uniform mid signal
      // so they never outrank a genuine similarity hit.
      return [{ name, artist: artistName, match: 0.5 }];
    });
  }

  /**
   * An artist's best-known tracks.
   *
   * This is what lets the *taste profile* generate candidates instead of only
   * re-ranking them: a listener's favourite artists become a candidate source
   * of their own, so autoplay is anchored to the person's taste rather than
   * orbiting whatever song happens to be playing.
   */
  async artistTopTracks(artist: string, limit = 20): Promise<readonly SimilarTrack[]> {
    const body = await this.#call<ArtistTopTracksBody>('artist.gettoptracks', {
      artist,
      limit: String(limit),
      autocorrect: '1',
    });

    return (body?.toptracks?.track ?? []).flatMap((entry) => {
      const name = entry.name;
      const artistName = entry.artist?.name ?? artist;
      if (name === undefined) return [];
      // Popularity within one artist says nothing about similarity to the
      // session; a uniform mid signal keeps these from outranking real matches.
      return [{ name, artist: artistName, match: 0.5 }];
    });
  }

  #readTags(body: TopTagsBody | null): readonly LastFmTag[] {
    return (body?.toptags?.tag ?? []).flatMap((entry) =>
      entry.name === undefined ? [] : [{ name: entry.name.toLowerCase(), count: entry.count ?? 0 }],
    );
  }

  async #call<T>(method: string, params: Record<string, string>): Promise<T | null> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined || apiKey.length === 0) return null;

    const ttl = method.endsWith('toptags') ? TAG_TTL_MS : SIMILAR_TTL_MS;
    const cacheKey = `lastfm:${method}:${JSON.stringify(params)}`;

    return this.#cache.wrap<T>(cacheKey, ttl, async () => {
      const url = new URL(API_ROOT);
      url.searchParams.set('method', method);
      url.searchParams.set('format', 'json');
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      // Set last and never logged — the cache key above deliberately excludes it.
      url.searchParams.set('api_key', apiKey);

      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
          logger.debug({ method, status: response.status }, 'Last.fm request failed');
          return null;
        }
        return (await response.json()) as T;
      } catch (error) {
        logger.debug({ err: error, method }, 'Last.fm request errored');
        return null;
      }
    });
  }
}

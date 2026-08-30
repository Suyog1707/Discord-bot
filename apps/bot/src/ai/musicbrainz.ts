/**
 * MusicBrainz — canonical identity for artists and recordings.
 *
 * The scoring engine counts how often an artist appears, and that count is only
 * meaningful if "The Weeknd", "the weeknd" and "THE WEEKND" are one artist. Most
 * of that collapses with cheap local normalisation, which is why `normaliseArtist`
 * below is synchronous and used on every candidate — running a network lookup per
 * track would defeat the entire point of a batched pipeline.
 *
 * MusicBrainz is reserved for what normalisation cannot do: aliases and
 * transliterations that are not string-similar at all ("A.R. Rahman" vs
 * "ஏ. ஆர். ரகுமான்"), and credit variants that differ by more than punctuation.
 * Those lookups are rate-limited to MusicBrainz's published one-request-per-second
 * and cached for a month, because canonical identity effectively never changes.
 */
import { normaliseArtist, normaliseTrackTitle, primaryArtist } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';

import type { CacheService } from './cache.js';

const logger = getLogger('musicbrainz');

const API_ROOT = 'https://musicbrainz.org/ws/2/';
const REQUEST_TIMEOUT_MS = 5_000;
/** MusicBrainz asks for one request per second; 1100ms leaves room for clock skew. */
const MIN_REQUEST_SPACING_MS = 1_100;
/** Canonical identity does not churn. A month is conservative. */
const LOOKUP_TTL_MS = 30 * 24 * 60 * 60_000;

/** MusicBrainz requires a contactable User-Agent and blocks generic ones. */
const USER_AGENT = 'DiscordMusicPlatform/0.1.0 ( https://github.com/Suyog1707/Discord-Bot )';

export interface CanonicalArtist {
  /** MusicBrainz identifier, or null when nothing matched confidently. */
  readonly mbid: string | null;
  /** MusicBrainz's preferred spelling, or the normalised input as a fallback. */
  readonly name: string;
  /** Country code when known — a cheap, reliable language/region hint. */
  readonly country: string | null;
  /** MusicBrainz genre/style tags, lowercased. */
  readonly tags: readonly string[];
}

/**
 * The pure normalisers moved to `@discord-music/shared`: the dashboard has to
 * compute the same artist and track keys as the bot does, and two copies of a
 * canonical key are two keys. They are re-exported here so every existing
 * importer of this module keeps its import path.
 */
export { normaliseArtist, normaliseTrackTitle, primaryArtist };

interface ArtistSearchBody {
  readonly artists?: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly score?: number;
    readonly country?: string;
    readonly tags?: readonly { readonly name?: string }[];
  }[];
}

export class MusicBrainzService {
  readonly #cache: CacheService;
  readonly #enabled: boolean;

  /**
   * Serialises outbound requests. A promise chain rather than a queue array
   * because ordering does not matter here — only spacing does.
   */
  #gate: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(cache: CacheService, enabled = true) {
    this.#cache = cache;
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Resolve a credit string to its canonical artist.
   *
   * Returns a normalised-name-only result rather than null when MusicBrainz has
   * nothing (or is unreachable), so callers always have something to key on.
   */
  async canonicalArtist(raw: string): Promise<CanonicalArtist> {
    const lead = primaryArtist(raw);
    const normalised = normaliseArtist(lead);
    const fallback: CanonicalArtist = {
      mbid: null,
      name: normalised,
      country: null,
      tags: [],
    };

    if (!this.#enabled || normalised.length === 0) return fallback;

    const found = await this.#cache.wrap<CanonicalArtist>(
      `mb:artist:${normalised}`,
      LOOKUP_TTL_MS,
      async () => {
        const url = new URL('artist', API_ROOT);
        url.searchParams.set('query', `artist:"${lead}"`);
        url.searchParams.set('limit', '1');
        url.searchParams.set('fmt', 'json');

        const body = await this.#request<ArtistSearchBody>(url);
        const match = body?.artists?.[0];
        // MusicBrainz scores 0–100. Below ~85 the "match" is usually a different
        // act that shares a word, and a wrong merge is worse than no merge.
        if (match?.id === undefined || (match.score ?? 0) < 85) return null;

        return {
          mbid: match.id,
          name: normaliseArtist(match.name ?? lead),
          country: match.country ?? null,
          tags: (match.tags ?? []).flatMap((tag) =>
            tag.name === undefined ? [] : [tag.name.toLowerCase()],
          ),
        };
      },
    );

    return found ?? fallback;
  }

  async #request<T>(url: URL): Promise<T | null> {
    await this.#waitForSlot();
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.debug({ status: response.status }, 'MusicBrainz request failed');
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      logger.debug({ err: error }, 'MusicBrainz request errored');
      return null;
    }
  }

  /** Hold the caller until at least MIN_REQUEST_SPACING_MS has passed. */
  async #waitForSlot(): Promise<void> {
    const release = this.#gate.then(async () => {
      const wait = this.#lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#lastRequestAt = Date.now();
    });
    this.#gate = release;
    await release;
  }
}

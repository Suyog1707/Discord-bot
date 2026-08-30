/**
 * One song, described the way the recommender needs it.
 *
 * Providers expose no audio features — no tempo, no key, no energy — so every
 * "does this fit?" question has to be answered from metadata plus community
 * tags. Until now each consumer did that itself: the planner read raw Last.fm
 * tags, the scorer inferred language from those same tags with no notion of how
 * sure it was, and MusicBrainz country was looked up in one place and ignored
 * in another. The same track therefore looked like a different song depending
 * on which stage was asking.
 *
 * `TrackProfile` is that description computed once. It carries the canonical
 * identity, the folded genre vocabulary from `genre-taxonomy`, and — crucially
 * — a language with a *confidence*, so a caller can tell "the provider says
 * this is Hindi" apart from "this artist happens to be Indian".
 *
 * Two entry points, and the split is the point:
 *
 *  - `fromMetadata` is static and pure. No network, no cache, no `await`. It is
 *    what the hot path uses when it already holds tags, or when a lookup would
 *    cost more than the improvement is worth.
 *  - `resolve` adds one artist lookup (tags and country for the *primary*
 *    artist only) behind a week-long cache. A week, because an artist's genre
 *    and country do not change and the lookup is the expensive part.
 */
import type { CacheService } from './cache.js';
import { normaliseTags } from './genre-taxonomy.js';
import { identityOf, type TrackIdentity } from './identity.js';
import {
  type LanguageConfidence,
  type LanguageSource,
  resolveLanguage,
  type ResolvedLanguage,
} from './language.js';
import { primaryArtist } from './musicbrainz.js';

export type { LanguageConfidence as Confidence, LanguageSource } from './language.js';

export interface TrackProfile {
  /** Canonical track key from `identityOf` — the same key exclusion sets use. */
  readonly key: string;
  readonly artistKey: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string | null;
  /** 0 means "unknown", never "instant". */
  readonly durationMs: number;
  readonly isrc: string | null;
  readonly releaseYear: number | null;
  readonly language: {
    readonly value: string | null;
    readonly confidence: LanguageConfidence;
    readonly source: LanguageSource;
  };
  /** Canonical genre keys — safe to compare across sources and spellings. */
  readonly genres: readonly string[];
  readonly families: readonly string[];
  /** Meaningful tags no genre rule claimed. */
  readonly styles: readonly string[];
  /** Everything the profile was derived from, lowercased and deduped. */
  readonly rawTags: readonly string[];
  readonly provider: string | null;
}

export interface TrackProfileInput {
  readonly title: string;
  /** Lead credit, or a joined credit string — `primaryArtist` splits it. */
  readonly artist: string;
  readonly artists?: readonly string[];
  readonly album?: string | null;
  readonly durationMs?: number;
  readonly isrc?: string | null;
  /** As the provider gave it: `'2019-05-03'` or `'2019'` or junk. */
  readonly releaseDate?: string | null;
  readonly provider?: string | null;
  /** A provider's own language field, when it has one. Beats every inference. */
  readonly providerLanguage?: string | null;
  readonly tags?: readonly string[];
}

/**
 * Where artist-level tags come from.
 *
 * Deliberately narrower than `LastFmService`: plain strings in, so the caller
 * adapts whatever its client returns (Last.fm hands back `{ name, count }`) and
 * this module stays testable with a two-line fake. `artistCountry` is optional
 * because not every source has one.
 */
export interface TagSource {
  artistTags(artist: string): Promise<readonly string[]>;
  artistCountry?(artist: string): Promise<string | null>;
}

/** Artist facts do not change; the lookup is the only expensive part here. */
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface ArtistEnrichment {
  readonly tags: readonly string[];
  readonly country: string | null;
}

const NO_ENRICHMENT: ArtistEnrichment = { tags: [], country: null };

/** Leading four digits, which is where every provider puts the year. */
const YEAR_PATTERN = /^\s*(\d{4})/u;

/**
 * The year out of a release date, or null.
 *
 * Providers spell this at least three ways (`'2019-05-03'`, `'2019'`,
 * `'2019-05'`) and some put something else entirely in the field. A wrong year
 * is worse than none — release year feeds "more like this era" — so anything
 * outside a plausible recording range is rejected rather than coerced.
 */
export function releaseYearOf(releaseDate: string | null | undefined): number | null {
  if (releaseDate == null) return null;
  const match = YEAR_PATTERN.exec(releaseDate);
  if (match?.[1] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  return year >= 1_000 && year <= 2_999 ? year : null;
}

/** Trim, drop empties. Used for the fields where `''` must read as "absent". */
function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Lowercased, trimmed, deduped, order preserved. */
function mergeTags(...groups: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const tag of group) {
      const normalised = tag.toLowerCase().trim().replace(/\s+/gu, ' ');
      if (normalised.length === 0 || seen.has(normalised)) continue;
      seen.add(normalised);
      merged.push(normalised);
    }
  }
  return merged;
}

/**
 * Assemble the profile from the input plus whatever enrichment was available.
 *
 * The single place the shape is built, so `fromMetadata` and `resolve` cannot
 * drift apart — the only difference between them is what they pass in here.
 */
function buildProfile(
  input: TrackProfileInput,
  identity: TrackIdentity,
  enrichment: ArtistEnrichment,
): TrackProfile {
  const rawTags = mergeTags(input.tags ?? [], enrichment.tags);
  const { genres, families, styles } = normaliseTags(rawTags);

  const credited = (input.artists ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const fallbackArtist = input.artist.trim();
  const artists =
    credited.length > 0 ? credited : fallbackArtist.length > 0 ? [fallbackArtist] : [];

  const language: ResolvedLanguage = resolveLanguage({
    providerLanguage: input.providerLanguage ?? null,
    tags: rawTags,
    artistCountry: enrichment.country,
    title: input.title,
    artist: input.artist,
  });

  return {
    key: identity.key,
    artistKey: identity.artistKey,
    title: input.title.trim(),
    artists,
    album: trimmedOrNull(input.album),
    durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
    // ISRCs are compared case-insensitively; validation belongs to whoever
    // built the canonical track, which is where the field comes from.
    isrc: trimmedOrNull(input.isrc)?.toUpperCase() ?? null,
    releaseYear: releaseYearOf(input.releaseDate),
    language: {
      value: language.language,
      confidence: language.confidence,
      source: language.source,
    },
    genres,
    families,
    styles,
    rawTags,
    provider: trimmedOrNull(input.provider),
  };
}

export class TrackProfileResolver {
  readonly #tags: TagSource;
  readonly #cache: CacheService;

  constructor(tags: TagSource, cache: CacheService) {
    this.#tags = tags;
    this.#cache = cache;
  }

  /**
   * Pure: no lookups; uses only what the input carries.
   *
   * With no tags the language falls back to the title's writing system, which
   * is why the result is still worth having — a Devanagari title is a usable
   * medium-confidence answer for free, before any network call.
   */
  static fromMetadata(input: TrackProfileInput): TrackProfile {
    return buildProfile(input, identityOf(input.artist, input.title), NO_ENRICHMENT);
  }

  /** Enriched: adds artist tags/country via `TagSource` (cached 7d under `profile:${key}`). */
  async resolve(input: TrackProfileInput): Promise<TrackProfile> {
    const identity = identityOf(input.artist, input.title);
    const enrichment = await this.#enrich(identity.key, input.artist);
    return buildProfile(input, identity, enrichment);
  }

  /**
   * Artist tags and country for the primary artist, cached under the track key.
   *
   * Only the primary artist is looked up. A collaboration would otherwise cost
   * one round trip per credited name for a marginal gain — the lead credit is
   * what carries the scene.
   *
   * Every failure degrades to "no enrichment" rather than propagating: a
   * profile built from metadata alone is still useful, and a Last.fm outage
   * must not stop the music.
   */
  async #enrich(key: string, artist: string): Promise<ArtistEnrichment> {
    const lead = primaryArtist(artist).trim();
    if (lead.length === 0) return NO_ENRICHMENT;

    const cached = await this.#cache.wrap<ArtistEnrichment>(
      `profile:${key}`,
      PROFILE_TTL_MS,
      async () => {
        // A lookup that THREW is not "no tags": returning null lets the
        // cache's short negative TTL apply instead of a week of emptiness.
        const [tagsResult, countryResult] = await Promise.allSettled([
          this.#tags.artistTags(lead),
          this.#tags.artistCountry?.(lead) ?? Promise.resolve(null),
        ]);
        const tags = tagsResult.status === 'fulfilled' ? tagsResult.value : [];
        const country = countryResult.status === 'fulfilled' ? countryResult.value : null;
        const failed = tagsResult.status === 'rejected' || countryResult.status === 'rejected';
        return failed && tags.length === 0 ? null : { tags, country };
      },
    );

    return cached ?? NO_ENRICHMENT;
  }
}

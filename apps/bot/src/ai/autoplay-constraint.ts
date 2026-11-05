/**
 * The seed constraint: autoplay continues in the language AND the style
 * (rap / non-rap) of the song the listener asked for.
 *
 * This module is pure — no I/O, no cache. The resolver does the lookups and
 * hands the results here as a `Classification`; the planner and the music
 * layer's fallback ask `judgeCandidate` whether one candidate may follow the
 * seed. Keeping the verdict pure is what lets two very different callers (the
 * planner's pools and the YouTube-mix fallback) apply exactly the same rule.
 *
 * The rule is deliberately asymmetric about ignorance. A KNOWN difference
 * (Hindi seed, English candidate) always excludes. An UNKNOWN side never
 * excludes on its own, but it is only let through when the candidate's artist
 * is provably linked to the seed (same artist, or strong co-play) — a guess
 * that happens to be right is worth far less than a Hindi rap session turning
 * into English pop.
 */
import {
  languageFromTag,
  languageFromText,
  specificLanguagesFromTags,
  type LanguageConfidence,
} from './language.js';

export type MusicStyle = 'rap' | 'non-rap';

/** Which evidence contributed to a classification, for logs. */
export type ClassificationSource =
  'provider' | 'track-tags' | 'script' | 'artist-tags' | 'history' | 'cooccurrence';

export interface Classification {
  /** Non-null ONLY when confidence is 'high' or 'medium'. */
  readonly language: string | null;
  readonly style: MusicStyle | null;
  /** The language's confidence. */
  readonly confidence: LanguageConfidence;
  /** Every source that contributed language or style, deduped. */
  readonly sources: readonly ClassificationSource[];
}

/** Nothing known; also what a caller with no resolver uses. */
export const UNKNOWN_CLASSIFICATION: Classification = {
  language: null,
  style: null,
  confidence: 'none',
  sources: [],
};

/** A co-occurrence edge this strong counts as "these artists go together". */
export const LINKED_ARTIST_MIN_WEIGHT = 0.5;

/* ---------------------------------------------------------------------- style */

/** Tags are in popularity order; past the first few they are noise. */
const STYLE_TAG_WINDOW = 8;

const RAP_WORDS: ReadonlySet<string> = new Set([
  'rap',
  'trap',
  'drill',
  'grime',
  'hiphop',
  'gully',
]);
const NON_RAP_WORDS: ReadonlySet<string> = new Set([
  'pop',
  'filmi',
  'bollywood',
  'romantic',
  'indie',
  'rock',
  'alternative',
  'ghazal',
  'sufi',
  'qawwali',
  'soundtrack',
  'acoustic',
  'folk',
  'classical',
  'country',
  'rnb',
  'soul',
  'jazz',
  'blues',
  'electronic',
  'edm',
  'dance',
  'devotional',
  'ballad',
  'metal',
  'lofi',
]);

/** Whole words of a tag. "r&b" is folded first because '&' would split it. */
function wordsOf(tag: string): string[] {
  return tag
    .toLowerCase()
    .replace(/r\s*&\s*b/gu, 'rnb')
    .split(/[^a-z]+/u)
    .filter((word) => word.length > 0);
}

/** True when `words` contains `first` immediately followed by `second`. */
function hasPhrase(words: readonly string[], first: string, second: string): boolean {
  return words.some((word, index) => word === first && words[index + 1] === second);
}

function isRapTag(words: readonly string[]): boolean {
  return (
    words.some((word) => RAP_WORDS.has(word)) ||
    hasPhrase(words, 'hip', 'hop') ||
    hasPhrase(words, 'boom', 'bap')
  );
}

function isNonRapTag(words: readonly string[]): boolean {
  return (
    words.some((word) => NON_RAP_WORDS.has(word)) ||
    hasPhrase(words, 'singer', 'songwriter') ||
    words.includes('singersongwriter') ||
    hasPhrase(words, 'lo', 'fi')
  );
}

/**
 * Rap or not, from community tags; null when the tags do not say or split evenly.
 *
 * Whole-word matching only — "therapy" is not rap. A tag counts once and rap
 * wins inside a single tag ("pop rap" is rap), because a rapper's crossover
 * tag must not read as a pop singer.
 */
export function styleFromTags(tags: readonly string[]): MusicStyle | null {
  let rap = 0;
  let nonRap = 0;
  for (const tag of tags.slice(0, STYLE_TAG_WINDOW)) {
    const words = wordsOf(tag);
    if (isRapTag(words)) rap += 1;
    else if (isNonRapTag(words)) nonRap += 1;
  }
  if (rap > nonRap) return 'rap';
  if (nonRap > rap) return 'non-rap';
  return null;
}

/* ------------------------------------------------------------------- language */

const ANGLOPHONE_WORDS: ReadonlySet<string> = new Set([
  'american',
  'british',
  'canadian',
  'australian',
  'irish',
  'uk',
  'britpop',
]);

/**
 * The language an ARTIST's tags imply for a given song, or null.
 *
 * Only tags that name a language count ("hindi rap", "bollywood"); "desi" and
 * "indian" name a scene, and India records in a dozen languages. Two named
 * languages is ambiguity, not a vote. English is the one exception that needs
 * a nationality, because nobody tags "english": an anglophone nationality
 * tag, a Latin-script title, real genre tags beside it, and no tag pointing
 * at any other language or region.
 */
export function languageFromArtistTags(tags: readonly string[], title: string): string | null {
  const specific = specificLanguagesFromTags(tags);
  if (specific.size === 1) return [...specific][0] ?? null;
  if (specific.size > 1) return null;

  if (languageFromText(title) !== null) return null;
  // A lone nationality tag is not enough: "american" alone is also a Spanish
  // singer living in Miami.
  if (tags.length < 2) return null;
  const anglophone = tags.some((tag) => wordsOf(tag).some((word) => ANGLOPHONE_WORDS.has(word)));
  if (!anglophone) return null;
  // "latin", "indian", "desi", "brazilian" all point elsewhere and veto it.
  const pointsElsewhere = tags.some((tag) => {
    const language = languageFromTag(tag);
    return language !== null && language !== 'english';
  });
  return pointsElsewhere ? null : 'english';
}

/* -------------------------------------------------------------------- verdict */

export interface ConstraintContext {
  readonly seed: Classification;
  /** The seed's own artist(s): always linked. */
  readonly seedArtistKeys: ReadonlySet<string>;
  /** Artists the room's behaviour strongly ties to the seed's artist. */
  readonly linkedArtistKeys: ReadonlySet<string>;
}

export type ConstraintVerdict = 'allow' | 'language' | 'style' | 'unlinked';

/**
 * May this candidate follow the seed?
 *
 * Known differences exclude first (language, then style). Unknowns are then
 * allowed only for linked artists. `Classification` guarantees a null language
 * for low or no confidence, so "known" is simply "non-null".
 */
export function judgeCandidate(
  candidate: Classification,
  artistKey: string,
  context: ConstraintContext,
): ConstraintVerdict {
  const { seed } = context;
  const linked = context.seedArtistKeys.has(artistKey) || context.linkedArtistKeys.has(artistKey);

  if (
    seed.language !== null &&
    candidate.language !== null &&
    seed.language !== candidate.language
  ) {
    return 'language';
  }
  if (seed.style !== null && candidate.style !== null && seed.style !== candidate.style) {
    return 'style';
  }
  if (seed.language === null && !linked) return 'unlinked';
  if (seed.language !== null && candidate.language === null && !linked) return 'unlinked';
  if (seed.style !== null && candidate.style === null && !linked) return 'unlinked';
  return 'allow';
}

/** What the room already knows around a seed, handed to the seed classifier. */
export interface SeedHistory {
  readonly sameArtist: readonly { readonly title: string; readonly artist: string }[];
  readonly coplayed: readonly {
    readonly title: string;
    readonly artist: string;
    readonly weight: number;
  }[];
}

/**
 * Folding community tags into a small, stable genre vocabulary.
 *
 * Last.fm and MusicBrainz tags are a folksonomy: the same scene arrives as
 * "Bollywood", "bollywood", "Filmi" and "Hindi Film Songs", and every one of
 * those is a *different* key to the scorer. That is why taste affinity looked
 * broken on Indian catalogues — a listener who finished twenty "Bollywood"
 * tracks got no credit at all for the next one tagged "filmi", because the two
 * strings never met.
 *
 * The fix is a canonical layer, not a bigger tag list: every tag is folded into
 * at most a handful of `genre` keys plus the broader `family` each genre
 * belongs to, and whatever is left over survives as `styles`. Downstream the
 * genres and families are appended to a candidate's tags, so an affinity
 * learned under either spelling now matches.
 *
 * The taxonomy is DATA, not code: `GENRE_RULES` is a table of
 * `{ genre, family, tokens }` and `normaliseTags` is a dumb matcher over it.
 * Adding a scene means adding a row. Two properties of the table matter:
 *
 *  - **A tag may hit several rules.** "desi hip hop" is both an Indian scene
 *    and hip-hop, and both facts are useful; the scorer wants the union, not a
 *    winner. This is deliberately unlike `language.ts`, where a tag has exactly
 *    one language and the first match wins.
 *  - **Order is presentation only.** Rules are listed specific-first so the
 *    output reads sensibly ("bollywood" before "pop"), but nothing is skipped
 *    because an earlier rule matched.
 *
 * Matching is by whole word sequence, never substring. Substring matching is
 * what makes "indie" look like "indian" and "meditation" look like "edit";
 * every tag and every token is folded to a space-separated word list and
 * compared with padding, so "hip hop" matches "indian hip hop" but "pop" does
 * not match "popular".
 */
import { languageFromTag } from './language.js';

export interface GenreRule {
  /** Canonical genre key, e.g. `'bollywood'`. Lowercase, hyphenated. */
  readonly genre: string;
  /** The broader family the genre rolls up into, e.g. `'indian'`. */
  readonly family: string;
  /**
   * Spellings that imply this genre. Written naturally ("hip hop", "r&b");
   * they are folded to the same canonical word form as incoming tags, so
   * punctuation and casing here are cosmetic.
   */
  readonly tokens: readonly string[];
}

/**
 * The taxonomy. Roughly forty rows, ordered specific-first.
 *
 * Regional Indian scenes come first because they are the ones the generic rows
 * would otherwise flatten: "punjabi pop" must record `punjabi` as well as
 * `pop`, and listing it first is what makes the output read that way.
 */
export const GENRE_RULES: readonly GenreRule[] = [
  // --- Indian subcontinent ------------------------------------------------
  {
    genre: 'bollywood',
    family: 'indian',
    tokens: ['bollywood', 'filmi', 'filmy', 'hindi film', 'hindi film songs', 'hindi cinema'],
  },
  { genre: 'indian-pop', family: 'indian', tokens: ['indian pop', 'indipop', 'desi pop'] },
  { genre: 'punjabi', family: 'indian', tokens: ['punjabi', 'bhangra'] },
  { genre: 'tamil', family: 'indian', tokens: ['tamil', 'kollywood'] },
  { genre: 'telugu', family: 'indian', tokens: ['telugu', 'tollywood'] },
  { genre: 'malayalam', family: 'indian', tokens: ['malayalam', 'mollywood'] },
  { genre: 'kannada', family: 'indian', tokens: ['kannada', 'sandalwood'] },
  { genre: 'bengali', family: 'indian', tokens: ['bengali', 'bangla'] },
  { genre: 'marathi', family: 'indian', tokens: ['marathi'] },
  { genre: 'ghazal', family: 'indian', tokens: ['ghazal', 'ghazals'] },
  { genre: 'sufi', family: 'indian', tokens: ['sufi', 'qawwali'] },
  {
    genre: 'devotional',
    family: 'indian',
    tokens: ['devotional', 'bhajan', 'bhajans', 'kirtan', 'mantra'],
  },
  {
    genre: 'indian-classical',
    family: 'indian',
    tokens: ['indian classical', 'hindustani', 'carnatic', 'raga'],
  },
  {
    genre: 'desi-hip-hop',
    family: 'indian',
    tokens: ['desi hip hop', 'indian hip hop', 'hindi rap', 'punjabi rap', 'desi rap'],
  },

  // --- Hip-hop and R&B ----------------------------------------------------
  {
    genre: 'hip-hop',
    family: 'hip-hop',
    tokens: ['hip hop', 'hiphop', 'rap', 'trap', 'drill', 'boom bap', 'gangsta rap'],
  },
  {
    genre: 'rnb',
    family: 'rnb',
    tokens: ['r&b', 'rnb', 'r and b', 'rhythm and blues', 'contemporary r&b'],
  },
  { genre: 'soul', family: 'rnb', tokens: ['soul', 'neo soul', 'motown'] },
  { genre: 'funk', family: 'rnb', tokens: ['funk', 'disco'] },

  // --- Pop ----------------------------------------------------------------
  { genre: 'pop', family: 'pop', tokens: ['pop', 'dance pop', 'teen pop', 'pop music'] },
  { genre: 'k-pop', family: 'asian-pop', tokens: ['k-pop', 'kpop', 'korean pop'] },
  { genre: 'j-pop', family: 'asian-pop', tokens: ['j-pop', 'jpop', 'japanese pop', 'city pop'] },
  { genre: 'c-pop', family: 'asian-pop', tokens: ['c-pop', 'cpop', 'mandopop', 'cantopop'] },

  // --- Guitar music -------------------------------------------------------
  {
    genre: 'rock',
    family: 'rock',
    tokens: ['rock', 'classic rock', 'hard rock', 'punk', 'post punk', 'grunge'],
  },
  {
    genre: 'alternative',
    family: 'rock',
    tokens: ['alternative', 'alt rock', 'indie rock', 'indie', 'shoegaze'],
  },
  {
    genre: 'metal',
    family: 'metal',
    tokens: ['metal', 'heavy metal', 'death metal', 'black metal', 'metalcore', 'thrash'],
  },

  // --- Electronic ---------------------------------------------------------
  {
    genre: 'electronic',
    family: 'electronic',
    tokens: ['electronic', 'electronica', 'edm', 'synthpop', 'synth pop', 'idm'],
  },
  {
    genre: 'house',
    family: 'electronic',
    tokens: ['house', 'deep house', 'tech house', 'progressive house'],
  },
  { genre: 'techno', family: 'electronic', tokens: ['techno', 'trance', 'hardstyle'] },
  {
    genre: 'bass',
    family: 'electronic',
    tokens: ['dubstep', 'drum and bass', 'dnb', 'future bass'],
  },

  // --- Low-energy ---------------------------------------------------------
  { genre: 'lofi', family: 'chill', tokens: ['lofi', 'lo-fi', 'chillhop', 'chillout'] },
  {
    genre: 'ambient',
    family: 'chill',
    tokens: ['ambient', 'downtempo', 'new age', 'meditation music'],
  },

  // --- Elsewhere in the world ---------------------------------------------
  {
    genre: 'latin',
    family: 'latin',
    tokens: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'latin pop'],
  },
  {
    genre: 'brazilian',
    family: 'latin',
    tokens: ['brazilian', 'bossa nova', 'samba', 'mpb', 'forro'],
  },
  {
    genre: 'afrobeats',
    family: 'african',
    tokens: ['afrobeat', 'afrobeats', 'amapiano', 'afropop'],
  },
  { genre: 'reggae', family: 'caribbean', tokens: ['reggae', 'dancehall', 'ska', 'dub'] },
  { genre: 'arabic', family: 'middle-eastern', tokens: ['arabic', 'khaleeji', 'rai'] },
  { genre: 'turkish', family: 'middle-eastern', tokens: ['turkish', 'anadolu rock'] },

  // --- Older forms --------------------------------------------------------
  { genre: 'jazz', family: 'jazz', tokens: ['jazz', 'bebop', 'swing', 'smooth jazz'] },
  { genre: 'blues', family: 'jazz', tokens: ['blues', 'delta blues'] },
  {
    genre: 'classical',
    family: 'classical',
    tokens: ['classical', 'orchestral', 'baroque', 'opera', 'symphony'],
  },
  {
    genre: 'soundtrack',
    family: 'soundtrack',
    tokens: ['soundtrack', 'ost', 'film score', 'score', 'musical'],
  },
  { genre: 'country', family: 'country', tokens: ['country', 'bluegrass', 'americana'] },
  {
    genre: 'folk',
    family: 'folk',
    tokens: ['folk', 'acoustic', 'singer songwriter', 'singer-songwriter'],
  },
  { genre: 'gospel', family: 'gospel', tokens: ['gospel', 'worship', 'praise', 'christian'] },
];

/**
 * Tags that describe the *listener*, not the music.
 *
 * Last.fm's most common tags by volume are things like "seen live" and
 * "favorites" — library bookkeeping that would otherwise become affinity keys
 * shared by every song a person likes, which is the same as no key at all.
 */
const JUNK_TAGS: ReadonlySet<string> = new Set([
  'seen live',
  'favorites',
  'favourites',
  'favorite',
  'favourite',
  'favorite songs',
  'favourite songs',
  'my favorites',
  'my favourites',
  'all',
  'awesome',
  'love',
  'loved',
  'love it',
  'love songs at heart',
  'best',
  'best songs',
  'good',
  'good music',
  'cool',
  'nice',
  'music',
  'song',
  'songs',
  'albums i own',
  'my music',
  'check out',
  'to listen',
  'unknown',
  'other',
  'misc',
]);

/** "80s", "1990s", "2010s", "00s" — an era, not a genre. */
const DECADE_PATTERN = /^(?:19|20)?\d{2}s$/u;

/** A tag that is nothing but digits ("2019", "10") carries no meaning here. */
const NUMERIC_PATTERN = /^\d+$/u;

/**
 * Fold a tag to the form both sides of a match are compared in: lowercase,
 * apostrophes deleted (so "90's" stays one word), every other run of
 * non-alphanumerics collapsed to a single space.
 *
 * Deleting apostrophes rather than spacing them is what keeps "rock 'n' roll"
 * from turning into three stray words.
 */
function canonicaliseTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Every rule pre-folded once at module load; `normaliseTags` runs per candidate. */
const COMPILED_RULES: readonly (readonly [GenreRule, readonly string[]])[] = GENRE_RULES.map(
  (rule) => [rule, rule.tokens.map((token) => ` ${canonicaliseTag(token)} `)] as const,
);

export interface NormalisedTags {
  /** Canonical genre keys, in taxonomy order, deduped. */
  readonly genres: readonly string[];
  /** The families those genres belong to, deduped. */
  readonly families: readonly string[];
  /** Meaningful tags no rule claimed, lowercased and deduped. */
  readonly styles: readonly string[];
}

const EMPTY: NormalisedTags = { genres: [], families: [], styles: [] };

/**
 * Whether a leftover tag is worth keeping as a style.
 *
 * Language tokens are dropped because `language.ts` has already consumed them
 * into a single, confidence-weighted answer; leaving "hindi" in the style list
 * as well would let the same fact be counted twice by the scorer.
 */
function isMeaningfulStyle(canonical: string): boolean {
  if (canonical.length === 0) return false;
  if (JUNK_TAGS.has(canonical)) return false;
  if (DECADE_PATTERN.test(canonical)) return false;
  if (NUMERIC_PATTERN.test(canonical)) return false;
  return languageFromTag(canonical) === null;
}

/**
 * Fold raw tags into canonical genres, their families, and the leftovers.
 *
 * Nothing here throws or filters the input for validity: tags arrive from
 * third parties and an empty or nonsense list must simply produce empty
 * arrays.
 */
export function normaliseTags(tags: readonly string[]): NormalisedTags {
  if (tags.length === 0) return EMPTY;

  const genres: string[] = [];
  const families: string[] = [];
  const styles: string[] = [];
  const seenGenres = new Set<string>();
  const seenFamilies = new Set<string>();
  const seenStyles = new Set<string>();

  for (const raw of tags) {
    const canonical = canonicaliseTag(raw);
    if (canonical.length === 0) continue;

    const padded = ` ${canonical} `;
    let matched = false;

    for (const [rule, tokens] of COMPILED_RULES) {
      if (!tokens.some((token) => padded.includes(token))) continue;
      matched = true;
      if (!seenGenres.has(rule.genre)) {
        seenGenres.add(rule.genre);
        genres.push(rule.genre);
      }
      if (!seenFamilies.has(rule.family)) {
        seenFamilies.add(rule.family);
        families.push(rule.family);
      }
    }

    if (matched || !isMeaningfulStyle(canonical)) continue;

    // Styles keep the tag's own punctuation ("lo-fi beats"), because that is
    // the spelling historical affinity keys were recorded under; only casing
    // and stray whitespace are normalised. Dedupe is on the folded form so
    // "Lo-Fi" and "lo fi" cannot both survive.
    if (seenStyles.has(canonical)) continue;
    seenStyles.add(canonical);
    styles.push(raw.toLowerCase().trim().replace(/\s+/gu, ' '));
  }

  return { genres, families, styles };
}

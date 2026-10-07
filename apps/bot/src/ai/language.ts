/**
 * Reading a language out of community tags.
 *
 * This is the signal behind "if I play a Hindi song, give me Hindi songs". There
 * is no language field on any of the sources involved — Last.fm and MusicBrainz
 * both express it as ordinary tags — so it has to be inferred from vocabulary.
 *
 * Matching is by substring, not equality, and that is the whole trick. Tag
 * vocabularies are folksonomies: the same scene is tagged "desi", "desi hip
 * hop", "indian hip hop" and "hindi rap" by different people. An exact-match
 * table looked correct and matched almost nothing — a live profile of a guild
 * listening to Indian hip hop produced no language at all, because not one of
 * its tags was spelled exactly like a table key.
 *
 * Ordering matters: more specific tokens are tested first, so "punjabi hip hop"
 * resolves to Punjabi rather than being caught by a broader Indian token.
 */

/**
 * One row of the language table.
 *
 * `specific` is the difference between "this tag names a language" and "this
 * tag names a country". "hindi" and "k-pop" pin the lyrics; "british",
 * "american", "indian" and "desi" only say where the artist is from, and India
 * alone has a couple of dozen recording languages. Both kinds of token must
 * stay in one table — they are matched in the same specific-first order, and
 * splitting them into two tables would mean matching twice and reasoning about
 * which pass wins. The flag rides along instead, and `resolveLanguage` turns it
 * into confidence.
 */
interface LanguageToken {
  readonly token: string;
  readonly language: string;
  /** True when the token names the language itself rather than a nationality. */
  readonly specific: boolean;
}

/** Token to canonical language, most specific first. */
const LANGUAGE_TOKENS: readonly LanguageToken[] = [
  { token: 'punjabi', language: 'punjabi', specific: true },
  { token: 'bhangra', language: 'punjabi', specific: true },
  { token: 'tamil', language: 'tamil', specific: true },
  { token: 'kollywood', language: 'tamil', specific: true },
  { token: 'telugu', language: 'telugu', specific: true },
  { token: 'tollywood', language: 'telugu', specific: true },
  { token: 'malayalam', language: 'malayalam', specific: true },
  { token: 'kannada', language: 'kannada', specific: true },
  { token: 'bengali', language: 'bengali', specific: true },
  { token: 'marathi', language: 'marathi', specific: true },
  { token: 'gujarati', language: 'gujarati', specific: true },
  { token: 'urdu', language: 'urdu', specific: true },
  { token: 'bollywood', language: 'hindi', specific: true },
  { token: 'filmi', language: 'hindi', specific: true },
  { token: 'hindi', language: 'hindi', specific: true },
  // Broad Indian tokens come after the specific ones so "punjabi hip hop" is
  // not swallowed here; these catch "desi hip hop", "indian pop" and the like.
  // They are nationality tokens: an "indian pop" track is more likely Hindi
  // than anything else, but Tamil and Punjabi wear the same tag.
  { token: 'desi', language: 'hindi', specific: false },
  { token: 'indian', language: 'hindi', specific: false },
  { token: 'k-pop', language: 'korean', specific: true },
  { token: 'kpop', language: 'korean', specific: true },
  { token: 'korean', language: 'korean', specific: true },
  { token: 'j-pop', language: 'japanese', specific: true },
  { token: 'jpop', language: 'japanese', specific: true },
  { token: 'japanese', language: 'japanese', specific: true },
  { token: 'reggaeton', language: 'spanish', specific: true },
  { token: 'spanish', language: 'spanish', specific: true },
  // "latin" is a region covering Spanish AND Portuguese; it guesses Spanish.
  { token: 'latin', language: 'spanish', specific: false },
  { token: 'french', language: 'french', specific: true },
  { token: 'arabic', language: 'arabic', specific: true },
  { token: 'turkish', language: 'turkish', specific: true },
  { token: 'portuguese', language: 'portuguese', specific: true },
  { token: 'brazilian', language: 'portuguese', specific: false },
  // Nationality tags are how Last.fm actually marks anglophone artists —
  // nobody tags "english", but "british" and "american" are everywhere. They
  // sit BELOW 'latin', so "latin american" resolves to Spanish first.
  { token: 'britpop', language: 'english', specific: false },
  { token: 'british', language: 'english', specific: false },
  { token: 'american', language: 'english', specific: false },
  { token: 'australian', language: 'english', specific: false },
  { token: 'english', language: 'english', specific: true },
];

/** The table row a tag matches, or null. The one place the table is scanned. */
function matchLanguageToken(tag: string): LanguageToken | null {
  const normalised = tag.toLowerCase();
  for (const entry of LANGUAGE_TOKENS) {
    if (normalised.includes(entry.token)) return entry;
  }
  return null;
}

/**
 * The language a single tag implies, or null when it says nothing.
 *
 * Most tags say nothing — "chill", "2020s", "guitar" — and returning null for
 * them is important: the scorer treats an unknown language as uninformative
 * rather than wrong, so a false positive here would actively mis-rank.
 */
export function languageFromTag(tag: string): string | null {
  return matchLanguageToken(tag)?.language ?? null;
}

/** The first language any of `tags` implies. */
export function languageFromTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const language = languageFromTag(tag);
    if (language !== null) return language;
  }
  return null;
}

/** A strict recording-language tag, not a regional genre or nationality.
 * Multiple named languages are ambiguous/bilingual and cannot fill an
 * exclusively single-language radio slot. */
export function recordingLanguageFromTags(tags: readonly string[]): string | null {
  const names = new Set(LANGUAGE_TOKENS.map((entry) => entry.language));
  const found = new Set<string>();
  for (const tag of tags) {
    for (const word of tag.toLowerCase().split(/[^a-z]+/u)) {
      if (names.has(word)) found.add(word);
    }
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/**
 * Writing systems that pin a language on their own. A Devanagari title is a
 * Hindi song no matter what the tags say — and unlike tags, the title is
 * available for free, with no lookup, before any network call.
 *
 * Latin script is deliberately absent: Bollywood tracks are routinely
 * transliterated ("Tum Hi Ho"), so Latin text says nothing about language.
 */
const SCRIPT_RANGES: readonly (readonly [RegExp, string])[] = [
  [/[ऀ-ॿ]/u, 'hindi'], // Devanagari
  [/[਀-੿]/u, 'punjabi'], // Gurmukhi
  [/[ঀ-৿]/u, 'bengali'],
  [/[஀-௿]/u, 'tamil'],
  [/[ఀ-౿]/u, 'telugu'],
  [/[ಀ-೿]/u, 'kannada'],
  [/[ഀ-ൿ]/u, 'malayalam'],
  [/[가-힯ᄀ-ᇿ]/u, 'korean'], // Hangul
  [/[぀-ヿ]/u, 'japanese'], // Hiragana + Katakana
  [/[؀-ۿ]/u, 'arabic'],
];

/**
 * The language a piece of text implies by its writing system, or null when the
 * script is ambiguous (Latin, digits, punctuation).
 */
export function languageFromText(text: string): string | null {
  for (const [pattern, language] of SCRIPT_RANGES) {
    if (pattern.test(text)) return language;
  }
  return null;
}

/**
 * How much the answer is worth trusting.
 *
 * The scorer penalises a candidate whose language contradicts the session's,
 * and that penalty is only safe when the language is actually known. Before
 * this existed, a Devanagari title and an explicit provider language were
 * treated identically — so a transliterated English-language track by an Indian
 * artist got penalised out of the queue on the strength of a nationality tag.
 * Confidence lets the caller gate: only `medium` and `high` should move a
 * ranking, `low` and `none` are for display.
 *
 * `low` is reserved: no source currently produces it, but callers that already
 * branch on it stay correct if a weaker source is added.
 */
export type LanguageConfidence = 'high' | 'medium' | 'low' | 'none';

/** Which signal produced the language, for logging and explanations. */
export type LanguageSource = 'provider' | 'tags' | 'artist' | 'script' | 'none';

export interface ResolvedLanguage {
  /** Canonical language name (`'hindi'`), or null when nothing said anything. */
  readonly language: string | null;
  readonly confidence: LanguageConfidence;
  readonly source: LanguageSource;
}

export interface LanguageInput {
  /** A metadata provider's own language field, when it has one. Trusted. */
  readonly providerLanguage?: string | null;
  /** Community tags for the track or its artist. */
  readonly tags?: readonly string[];
  /**
   * Tags on the TRACK itself, as opposed to its artist. Scanned before
   * `tags`: an artist who sings in three languages tells you little about
   * one song, but a song tagged "hindi" by the people who listened to it is
   * evidence about exactly the recording in question. This is the legitimate
   * signal that rescues a transliterated title — and when the track carries
   * no such tag, the answer stays unknown rather than guessed.
   */
  readonly trackTags?: readonly string[];
  /** ISO 3166-1 alpha-2 country for the primary artist, e.g. from MusicBrainz. */
  readonly artistCountry?: string | null;
  readonly title: string;
  readonly artist: string;
}

/** Nothing known. A shared constant because it is returned from four places. */
const UNKNOWN_LANGUAGE: ResolvedLanguage = { language: null, confidence: 'none', source: 'none' };

/**
 * ISO 639-1 codes to the canonical names the rest of the stack uses.
 *
 * Providers are inconsistent: some send `"hi"`, some `"hi-IN"`, some `"Hindi"`.
 * Names pass through lowercased, so only the codes need a table.
 */
const LANGUAGE_CODES: ReadonlyMap<string, string> = new Map([
  ['hi', 'hindi'],
  ['en', 'english'],
  ['pa', 'punjabi'],
  ['ta', 'tamil'],
  ['te', 'telugu'],
  ['ml', 'malayalam'],
  ['kn', 'kannada'],
  ['bn', 'bengali'],
  ['mr', 'marathi'],
  ['gu', 'gujarati'],
  ['ur', 'urdu'],
  ['ko', 'korean'],
  ['ja', 'japanese'],
  ['zh', 'chinese'],
  ['es', 'spanish'],
  ['pt', 'portuguese'],
  ['fr', 'french'],
  ['de', 'german'],
  ['it', 'italian'],
  ['ru', 'russian'],
  ['ar', 'arabic'],
  ['tr', 'turkish'],
  ['nl', 'dutch'],
  ['id', 'indonesian'],
  ['th', 'thai'],
  ['vi', 'vietnamese'],
]);

/**
 * Countries whose recording output is lopsided enough for the artist's passport
 * to imply the lyrics — and only those.
 *
 * India is the pointed omission: an Indian artist may record in any of a dozen
 * languages, and guessing Hindi from `IN` is exactly the mistake that buried
 * Tamil and Punjabi tracks in a Hindi session. The US and the UK are omitted
 * for the mirror-image reason: a Spanish-language or Punjabi artist based in
 * either is completely ordinary, and "American therefore English" is a guess
 * dressed as a fact. When a country is ambiguous the answer is *no answer* —
 * the next source, or none at all.
 */
const COUNTRY_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['KR', 'korean'],
  ['JP', 'japanese'],
  ['FR', 'french'],
  ['ES', 'spanish'],
  ['MX', 'spanish'],
  ['AR', 'spanish'],
  ['CO', 'spanish'],
  ['CL', 'spanish'],
  ['PE', 'spanish'],
  ['BR', 'portuguese'],
  ['PT', 'portuguese'],
  ['DE', 'german'],
  ['IT', 'italian'],
  ['RU', 'russian'],
  ['TR', 'turkish'],
  ['SA', 'arabic'],
  ['EG', 'arabic'],
  ['TH', 'thai'],
  ['VN', 'vietnamese'],
  ['ID', 'indonesian'],
]);

/** Canonical language for a provider's language field, or null when unusable. */
export function languageFromProvider(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // "hi-IN" and "pt_BR" carry a region the canonical name has no room for.
  const cleaned = value.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  if (cleaned.length === 0) return null;
  return LANGUAGE_CODES.get(cleaned) ?? cleaned;
}

/**
 * The language an artist's country implies, or null when the country is silent
 * (unknown, or multilingual enough that a guess would be noise).
 */
export function languageFromCountry(country: string | null | undefined): string | null {
  if (typeof country !== 'string') return null;
  return COUNTRY_LANGUAGES.get(country.trim().toUpperCase()) ?? null;
}

/**
 * The best language available, with how much it is worth.
 *
 * Sources are consulted strongest-first and the first one that speaks wins:
 * a provider's own field (high), then tags (high when the tag names a language,
 * medium when it only names a nationality), then the artist's country (medium),
 * then the writing system of the title or artist name (medium — Devanagari is
 * usually Hindi, but Marathi and Nepali share the script).
 *
 * This never throws, by construction: every step is a lookup or a regex test
 * over an optional field, and an absent or nonsense value falls through to the
 * next source rather than raising. That matters because it runs on the hot path
 * of every candidate scored — an error here would take the whole autoplay
 * refill with it.
 */
export function resolveLanguage(input: LanguageInput): ResolvedLanguage {
  const provider = languageFromProvider(input.providerLanguage);
  if (provider !== null) return { language: provider, confidence: 'high', source: 'provider' };

  // Every tag is scanned for a language-SPECIFIC token before any tag is
  // read for a nationality: tags arrive in popularity order, and "indian"
  // sitting ahead of "tamil" must not turn a Tamil song Hindi.
  // Track-level evidence first, artist-level second — same rules for both,
  // but a specific track tag wins before an artist tag is even read.
  const tags = [...(input.trackTags ?? []), ...(input.tags ?? [])];
  let nationality: string | null = null;
  for (const tag of tags) {
    const matched = matchLanguageToken(tag);
    if (matched === null) continue;
    if (matched.specific) return { language: matched.language, confidence: 'high', source: 'tags' };
    nationality ??= matched.language;
  }

  // The song's own script outranks anything inferred about its artist: a
  // Devanagari title is Hindi whatever nationality tags the artist carries.
  // The artist name is a weaker but real fallback, because plenty of regional
  // releases carry a transliterated title under a native-script credit.
  for (const text of [input.title, input.artist]) {
    if (text.length === 0) continue;
    const script = languageFromText(text);
    if (script !== null) return { language: script, confidence: 'medium', source: 'script' };
  }

  const fromCountry = languageFromCountry(input.artistCountry);
  if (fromCountry !== null) {
    return { language: fromCountry, confidence: 'medium', source: 'artist' };
  }

  // A nationality tag alone ("indian", "british") is a hint, not a
  // language: low confidence, which the scorer deliberately ignores.
  if (nationality !== null) return { language: nationality, confidence: 'low', source: 'tags' };

  return UNKNOWN_LANGUAGE;
}

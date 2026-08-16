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

/** Token to canonical language, most specific first. */
const LANGUAGE_TOKENS: readonly (readonly [string, string])[] = [
  ['punjabi', 'punjabi'],
  ['bhangra', 'punjabi'],
  ['tamil', 'tamil'],
  ['kollywood', 'tamil'],
  ['telugu', 'telugu'],
  ['tollywood', 'telugu'],
  ['malayalam', 'malayalam'],
  ['kannada', 'kannada'],
  ['bengali', 'bengali'],
  ['marathi', 'marathi'],
  ['gujarati', 'gujarati'],
  ['urdu', 'urdu'],
  ['bollywood', 'hindi'],
  ['filmi', 'hindi'],
  ['hindi', 'hindi'],
  // Broad Indian tokens come after the specific ones so "punjabi hip hop" is
  // not swallowed here; these catch "desi hip hop", "indian pop" and the like.
  ['desi', 'hindi'],
  ['indian', 'hindi'],
  ['k-pop', 'korean'],
  ['kpop', 'korean'],
  ['korean', 'korean'],
  ['j-pop', 'japanese'],
  ['jpop', 'japanese'],
  ['japanese', 'japanese'],
  ['reggaeton', 'spanish'],
  ['spanish', 'spanish'],
  ['latin', 'spanish'],
  ['french', 'french'],
  ['arabic', 'arabic'],
  ['turkish', 'turkish'],
  ['portuguese', 'portuguese'],
  ['brazilian', 'portuguese'],
  ['english', 'english'],
];

/**
 * The language a single tag implies, or null when it says nothing.
 *
 * Most tags say nothing — "chill", "2020s", "guitar" — and returning null for
 * them is important: the scorer treats an unknown language as uninformative
 * rather than wrong, so a false positive here would actively mis-rank.
 */
export function languageFromTag(tag: string): string | null {
  const normalised = tag.toLowerCase();
  for (const [token, language] of LANGUAGE_TOKENS) {
    if (normalised.includes(token)) return language;
  }
  return null;
}

/** The first language any of `tags` implies. */
export function languageFromTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const language = languageFromTag(tag);
    if (language !== null) return language;
  }
  return null;
}

/**
 * Canonical track identity — one stable key per logical song.
 *
 * This is the fix for autoplay repeating itself. The same logical song shows up
 * under wildly different strings depending on where it came from: Last.fm gives
 * "Blinding Lights", a YouTube search result gives "The Weeknd - Blinding Lights
 * (Official Video)", another gives "Blinding Lights [Lyrics]", and history might
 * hold "Blinding Lights (Remastered 2020)". Exclusion sets are only as good as
 * their key, and comparing raw strings (or even `normaliseTrackTitle`, which is
 * built for MusicBrainz search queries, not identity) leaves every one of those
 * as a "different" song — so autoplay picks whichever one it hasn't seen yet and
 * repeats the track inside a few minutes.
 *
 * `identityOf` produces one key per (artist, title) pair by stripping the
 * decoration that carries no musical information (uploader noise, feature
 * credits, remaster tags) while carving out and preserving decoration that DOES
 * change the song: remixes, live takes, acoustic versions, covers, and the like.
 * Those become a separate `variant` component so "Blinding Lights" and
 * "Blinding Lights (Metro Boomin Remix)" are related but distinct.
 *
 * Variant handling deliberately over-merges within a class rather than under-
 * merging across classes: two different remixes of the same song collapse to
 * one `remix` key. For anti-repeat purposes that is correct — two remixes back
 * to back is still repetition — and the alternative (keying variants by their
 * full descriptive phrase) would let an infinite supply of "X Remix" / "Y
 * Remix" titles dodge the exclusion set entirely. What must never happen is a
 * remix collapsing into the original, so a variant is always a distinct key
 * from the plain song.
 *
 * Word-boundary care matters here specifically because variant words are short
 * and common as substrings: "edit" must not fire on "edition" or "meditation",
 * and "live" must not fire on "alive". Every variant/noise check below matches
 * on `\b`-bounded words for that reason.
 */
import { normaliseArtist, primaryArtist } from './musicbrainz.js';

export interface TrackIdentity {
  /** `${artistKey}::${titleKey}` or `${artistKey}::${titleKey}::${variant}`. */
  readonly key: string;
  /** `normaliseArtist(primaryArtist(artist))`. */
  readonly artistKey: string;
  /** Canonical title: noise stripped, variant words removed. */
  readonly titleKey: string;
  /** Sorted, `+`-joined variant markers (e.g. `'live+remix'`), or null. */
  readonly variant: string | null;
}

/**
 * Separators that mean "the artist repeated themselves in the title", the way
 * YouTube search results and Last.fm both do it: "The Weeknd - Blinding
 * Lights". Order-independent — whichever appears first (leftmost) and whose
 * leading chunk actually matches the artist wins, so a title that merely
 * *contains* one of these later on is left alone.
 */
const ARTIST_TITLE_SEPARATORS = [' - ', ' – ', ': '] as const;

/**
 * Words that never distinguish one recording of a song from another. These are
 * only stripped when they appear inside a bracket/brace group or a trailing
 * ` - `/` | ` suffix chunk — never as a bare word in running text, because a
 * song can legitimately be *titled* "Audio" or "HD" and noise words are far
 * more likely to collide with real title text than variant words are.
 *
 * "remaster"/"remastered" belongs here, not in the variant list: a remaster is
 * an audio touch-up, not a different version of the song, so "Blinding Lights
 * (Remastered 2020)" must collapse into the same key as the plain title.
 */
const NOISE_PATTERNS: readonly string[] = [
  String.raw`\bofficial\b`,
  String.raw`\bvideo\b`,
  String.raw`\baudio\b`,
  String.raw`\blyrics?\b`,
  String.raw`\blyrical\b`,
  String.raw`\bvisuali[sz]er\b`,
  String.raw`\bhd\b`,
  String.raw`\b4k\b`,
  String.raw`\bmv\b`,
  String.raw`\bout\s+now\b`,
  String.raw`\bnew\s+song\b`,
  String.raw`\bremaster(?:ed)?\b`,
  // Bracketed feature credits ("(feat. DaBaby)", "(with The Weeknd)") land
  // here; the bare, unbracketed form ("Levitating feat. DaBaby") is handled
  // separately below because it has no closing delimiter to bound it. "with"
  // matters as much as "feat": Last.fm and Spotify spell 2020s collaborations
  // "Creepin' (with The Weeknd, 21 Savage)", and without this rule that title
  // and plain "Creepin'" were two different keys — the same song, queued
  // twice in one batch.
  String.raw`\b(?:feat|ft|featuring|with)\b\.?`,
];

/** Precompiled noise matchers — this runs per candidate on a 400-track pool. */
const NOISE_REGEXES: readonly RegExp[] = NOISE_PATTERNS.map((source) => new RegExp(source, 'iu'));

/**
 * Words that DO distinguish one recording from another, in the order the spec
 * lists them. The marker name (first element) is what ends up in `variant` —
 * deliberately shorter/coarser than the phrase that triggered it, so "Metro
 * Boomin Remix" and "Club Remix" both collapse to the single marker `remix`.
 *
 * "radio edit" is not its own entry: it is caught by the bare word `edit`,
 * which is exactly the merge we want (a remaster-style touch-up of the edit,
 * not a new song), while still refusing to fire on "edition"/"meditation".
 */
const VARIANT_MARKERS: readonly (readonly [string, string])[] = [
  ['remix', String.raw`\bremix(?:ed)?\b`],
  ['live', String.raw`\blive\b`],
  ['acoustic', String.raw`\bacoustic\b`],
  ['unplugged', String.raw`\bunplugged\b`],
  ['cover', String.raw`\bcover\b`],
  ['instrumental', String.raw`\binstrumental\b`],
  ['karaoke', String.raw`\bkaraoke\b`],
  ['sped-up', String.raw`\bsped[\s-]*up\b`],
  ['slowed', String.raw`\bslowed\b`],
  ['reverb', String.raw`\breverb\b`],
  ['mashup', String.raw`\bmash[\s-]?up\b`],
  ['edit', String.raw`\bedit\b`],
  ['lofi', String.raw`\blo[\s-]?fi\b`],
  ['extended', String.raw`\bextended\b`],
];

/**
 * Precompiled variant matchers: [marker, test, replace]. Compiling these per
 * call was measurable — `identityOf` runs twice per candidate per generation
 * pass, tens of thousands of regex constructions for one autoplay refill.
 */
const VARIANT_REGEXES: readonly (readonly [string, RegExp, RegExp])[] = VARIANT_MARKERS.map(
  ([marker, source]) => [marker, new RegExp(source, 'iu'), new RegExp(source, 'giu')] as const,
);

/** Trailing feature credit with no bracket to bound it: "Levitating feat. DaBaby". */
const BARE_FEATURE_SUFFIX = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu;

/** Any of (), [], {} as a single non-nested group, keeping its inner text. */
const BRACKET_CHUNK = /[([{]([^()[\]{}]*)[)\]}]/gu;

/** Trailing " - "/" – "/" | " suffix, checked from the right so mid-title dashes are left alone. */
const SUFFIX_SEPARATORS = [' - ', ' – ', ' | '] as const;

/** The set of variant markers `text` contains, tested independently (a phrase can hit several). */
function matchVariants(text: string): Set<string> {
  const found = new Set<string>();
  for (const [marker, test] of VARIANT_REGEXES) {
    if (test.test(text)) found.add(marker);
  }
  return found;
}

/** Whether `text` contains any pure-noise word. */
function matchesNoise(text: string): boolean {
  return NOISE_REGEXES.some((regex) => regex.test(text));
}

/**
 * Strip a leading "Artist - Title" / "Artist – Title" / "Artist: Title" repeat
 * of the artist. Compared on normalised forms so casing and channel-suffix
 * noise in the leading chunk ("The Weeknd - Topic") don't block the match.
 */
function stripArtistPrefix(title: string, artistKey: string): string {
  if (artistKey.length === 0) return title;
  let best: { idx: number; len: number } | null = null;
  for (const sep of ARTIST_TITLE_SEPARATORS) {
    const idx = title.indexOf(sep);
    if (idx === -1) continue;
    const leadKey = normaliseArtist(primaryArtist(title.slice(0, idx)));
    if (leadKey !== artistKey) continue;
    if (best === null || idx < best.idx) best = { idx, len: sep.length };
  }
  return best === null ? title : title.slice(best.idx + best.len);
}

/**
 * Remove every bracket/brace group that is pure noise or a variant marker.
 * Variant is checked first: a group like "(Metro Boomin Remix)" must record
 * `remix` and disappear, never get caught by some other noise rule and vanish
 * without leaving a trace of the variant.
 */
function stripBracketChunks(text: string, variants: Set<string>): string {
  return text.replace(BRACKET_CHUNK, (full: string, inner: string) => {
    const found = matchVariants(inner);
    if (found.size > 0) {
      for (const marker of found) variants.add(marker);
      return ' ';
    }
    return matchesNoise(inner) ? ' ' : full;
  });
}

/**
 * Strip a trailing " - X" / " – X" / " | X" chunk when X is pure noise or a
 * variant marker — e.g. "Blinding Lights - 2011 Remaster" or "Style - Radio
 * Edit". Uses the rightmost separator so a title that legitimately contains
 * " - " earlier (and wasn't consumed by the artist-prefix step) is untouched.
 * Runs a few times to catch a chained suffix ("Song - Remaster - Live").
 */
function stripSuffixChunk(text: string, variants: Set<string>): string {
  let result = text;
  for (let i = 0; i < 3; i += 1) {
    let best: { idx: number; len: number } | null = null;
    for (const sep of SUFFIX_SEPARATORS) {
      const idx = result.lastIndexOf(sep);
      if (idx === -1) continue;
      if (best === null || idx > best.idx) best = { idx, len: sep.length };
    }
    if (best === null) break;
    const tail = result.slice(best.idx + best.len);
    const found = matchVariants(tail);
    if (found.size > 0) {
      for (const marker of found) variants.add(marker);
      result = result.slice(0, best.idx);
      continue;
    }
    if (matchesNoise(tail)) {
      result = result.slice(0, best.idx);
      continue;
    }
    break;
  }
  return result;
}

/**
 * Catch variant words that show up bare in running text, with no bracket or
 * dash to delimit them ("Someone You Loved Acoustic"). Unlike noise words,
 * variant words ARE trusted as bare text — the spec calls for them to be found
 * "anywhere" — because misclassifying a real variant as ordinary title text is
 * the more expensive mistake here (it would let a remix dodge the exclusion
 * set entirely).
 */
function stripBareVariants(text: string, variants: Set<string>): string {
  let result = text;
  for (const [marker, test, replace] of VARIANT_REGEXES) {
    if (test.test(result)) {
      variants.add(marker);
      result = result.replace(replace, ' ');
    }
  }
  return result;
}

/**
 * Same character-folding rules as `normaliseArtist`'s tail, minus the
 * artist-only "the " strip.
 *
 * Combining marks are stripped only after LATIN base characters (é → e). In
 * Indic scripts the vowel signs ARE combining marks — stripping them deletes
 * every vowel, so सोच (soch) and सच (sach), two different words, collapsed
 * into one key and each permanently excluded the other from autoplay. The
 * lookbehind keeps accent-folding for Latin text while leaving Devanagari,
 * Gurmukhi, Bengali, Tamil and the rest intact.
 */
function flatten(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Canonical identity from artist + title strings, whatever vocabulary they
 * came from (Last.fm tag casing, a YouTube result title, play history).
 */
export function identityOf(artist: string, title: string): TrackIdentity {
  const artistKey = normaliseArtist(primaryArtist(artist));
  const variants = new Set<string>();

  let working = stripArtistPrefix(title, artistKey);
  working = working.replace(BARE_FEATURE_SUFFIX, '');
  working = stripBracketChunks(working, variants);
  working = stripSuffixChunk(working, variants);
  working = stripBareVariants(working, variants);

  // Never surface an empty key: if the whole title canonicalised away (it was
  // nothing but noise/variant decoration), fall back to the flattened raw
  // title so two garbage titles still get a comparable, non-empty key.
  const titleKey = flatten(working) || flatten(title) || 'unknown';

  const variant = variants.size > 0 ? [...variants].sort().join('+') : null;
  const key = variant === null ? `${artistKey}::${titleKey}` : `${artistKey}::${titleKey}::${variant}`;

  return { key, artistKey, titleKey, variant };
}

/** Convenience: just the key. */
export function trackKeyOf(artist: string, title: string): string {
  return identityOf(artist, title).key;
}

/**
 * Provider-scoped identifier key for exclusion sets, e.g. `'youtube:dQw4w9WgXcQ'`.
 * Only the source is normalised — identifiers are opaque provider IDs and are
 * often case-sensitive (YouTube video IDs, for one).
 */
export function identifierKeyOf(source: string, identifier: string): string {
  return `${source.trim().toLowerCase()}:${identifier.trim()}`;
}

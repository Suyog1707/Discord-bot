/**
 * Choosing which YouTube upload is actually the song Spotify named.
 *
 * Spotify identifies a recording; YouTube has to supply the audio. Taking the
 * first search result made that a coin toss on anything popular — searching a
 * soundtrack title returns the film's scene before the release, and searching a
 * hit returns reactions, shorts and fan edits alongside it. All of those are
 * "results", none of them are the song.
 *
 * What there is to judge on is narrow. Lavalink hands back a title, a channel
 * name, a duration and a livestream flag — no description, no view count, no
 * category. That turns out to be enough, because the three strongest signals
 * are all in there:
 *
 *   - Duration. A recording has one length. A scene, a short, an interview and
 *     a compilation almost never share it, and this is the signal that does not
 *     care what language the title is in or how it is decorated.
 *   - Channel. "<Artist> - Topic" is YouTube's own marker for an auto-generated
 *     official music upload, and VEVO is the label's. Neither can be faked by
 *     titling a video well.
 *   - Variant agreement. `identityOf` already separates a song's identity from
 *     its version markers, so "is this the live take when Spotify named the
 *     studio one" is a comparison rather than a guess.
 *
 * Everything else — the keyword bonuses, the junk penalties — is a tiebreak
 * between candidates the above could not separate. Penalties are weights, never
 * vetoes: songs are legitimately titled "Scene", soundtrack albums are named
 * after their films, and a word in the wrong place must not outvote a duration
 * match against a Topic channel.
 */
import { identityOf } from '../ai/identity.js';

/** What Lavalink gives us about one search result. */
export interface MatchCandidate {
  readonly title: string;
  /** YouTube channel name, SoundCloud uploader — whoever posted it. */
  readonly author: string;
  readonly durationMs: number;
  readonly isStream: boolean;
  readonly identifier: string;
}

/** The Spotify recording being matched. */
export interface WantedTrack {
  readonly title: string;
  readonly artist: string;
  readonly durationMs: number;
  readonly album?: string | null;
}

export interface ScoredCandidate<T extends MatchCandidate> {
  readonly candidate: T;
  readonly score: number;
  /** Signed contributions, largest magnitude first — for the log line. */
  readonly reasons: readonly string[];
  /**
   * The upload is attributable to the artist — a Topic or VEVO channel, an
   * official artist channel, or a channel whose name IS the artist.
   *
   * Score alone is not enough to stop searching. A well-titled lyrics reupload
   * with the right runtime scores about as well as a real release, and stopping
   * on it means never running the query that would have found the release.
   * {@link isConfident} requires this as well.
   */
  readonly authoritative: boolean;
}

/**
 * A winner at or above this needs no further searching. Calibrated so the
 * unambiguous case clears it on the first query: right duration, matching
 * title and artist, no unexpected variant, posted by a Topic or VEVO channel.
 */
export const CONFIDENT_SCORE = 80;

/**
 * Whether a winner is good enough to stop searching. Both halves matter: the
 * score says the metadata lines up, `authoritative` says the upload is
 * attributable to the artist. A lyrics reupload can satisfy the first alone.
 */
export function isConfident(entry: ScoredCandidate<MatchCandidate> | undefined): boolean {
  return entry !== undefined && entry.score >= CONFIDENT_SCORE && entry.authoritative;
}

/**
 * Below this, the best candidate is treated as no match at all, so the caller
 * can try another source rather than play it. Set well under zero on purpose:
 * a mediocre match still beats silence, and only actively wrong results — a
 * reaction video, a scene, something a third the right length — fall this far.
 */
export const REJECT_BELOW = -30;

/* -------------------------------------------------------------- normalising */

function flat(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function words(text: string): string[] {
  return flat(text).split(' ').filter(Boolean);
}

/**
 * Artists as separate names. Spotify joins collaborators with ", ", and a
 * YouTube upload usually credits only the lead — so matching any one of them
 * is the correct test, not matching the joined string.
 */
function artistNames(artist: string): string[] {
  return artist
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b/iu)
    .map((name) => flat(name))
    .filter((name) => name.length > 1);
}

/** `["official","audio"]` → matches "official audio" as an ordered phrase. */
function hasPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(flat(phrase));
}

/* ------------------------------------------------------------------ signals */

/** Phrases whose presence argues this is not the song. Weight is per phrase. */
const JUNK_PATTERNS: readonly (readonly [string, number])[] = [
  // Unambiguous: nothing titled this is a music release.
  ['reaction', -55],
  ['reacts to', -55],
  ['reviewed', -45],
  ['review', -40],
  ['interview', -50],
  ['explained', -40],
  ['breakdown', -35],
  ['behind the scenes', -45],
  ['making of', -45],
  ['bloopers', -45],
  ['shorts', -45],
  ['short film', -45],
  ['trailer', -40],
  ['teaser', -35],
  ['first look', -35],
  // Scenes and clips. "scene" alone is common in real titles, so the film-
  // specific phrasings carry the weight and the bare word stays mild.
  ['movie scene', -55],
  ['film scene', -55],
  ['tv scene', -55],
  ['movie clip', -55],
  ['film clip', -55],
  ['best scene', -50],
  ['scene from', -50],
  ['full scene', -55],
  ['full movie', -55],
  ['full episode', -50],
  ['episode', -30],
  ['dialogue', -45],
  // Bare "scene" and "clip" are the shapes that actually appear — "<Film> -
  // <Song> Scene", "Movie Clip: <Song>" — and at a token penalty they still
  // scored positive, so whenever the real release was missing from the results
  // one of them won. The wanted-title exemption below is what keeps a song
  // called "Love Scene" from being punished for its own name.
  ['scene', -45],
  ['clip', -40],
  // Serialised uploads: a song is not published in parts.
  ['part 1', -35],
  ['part 2', -35],
  ['part 3', -35],
  // The picturised cut. In Indian releases especially this is the version that
  // opens on dialogue and reaches the song half a minute in — exactly the
  // "scene first, song later" complaint — while the standalone audio or music
  // video of the same track sits alongside it.
  ['full video', -22],
  ['video song', -22],
  // Compilations and mixes: real audio, wrong object.
  ['compilation', -40],
  ['jukebox', -40],
  ['all songs', -40],
  ['full album', -25],
  ['nonstop', -35],
  ['megamix', -35],
  ['mashup', -30],
  // Fan-made derivatives.
  ['fan made', -40],
  ['fanmade', -40],
  ['whatsapp status', -45],
  ['status video', -40],
  ['ringtone', -45],
  ['bgm', -25],
  ['background music', -30],
  ['tutorial', -40],
  ['how to play', -40],
  // Re-encodes that are the same song but the wrong recording.
  ['8d audio', -35],
  ['nightcore', -35],
  ['bass boosted', -30],
  ['speed up', -25],
];

/** Title phrases that argue this IS the release. Highest match wins, not summed. */
const QUALITY_TIERS: readonly (readonly [string, number, string])[] = [
  ['official audio', 22, 'official-audio'],
  ['official visualizer', 20, 'official-visualiser'],
  ['official video song', 18, 'official-video-song'],
  ['official music video', 20, 'official-music-video'],
  ['official video', 16, 'official-video'],
  ['official song', 16, 'official-song'],
  ['full song', 12, 'full-song'],
  // Above the lyric tiers and matched before them. A bare "(Audio)" upload is
  // the standalone recording by definition, which is exactly what is wanted
  // here, while a lyrics channel tying with the label's audio cut let the
  // reupload win a coin toss.
  ['audio', 10, 'audio'],
  ['official', 9, 'official'],
  ['lyric video', 5, 'lyric-video'],
  ['lyrics', 4, 'lyrics'],
];

/**
 * Markers that disqualify a candidate outright rather than merely cost it
 * points.
 *
 * Scoring alone was not enough. A scene upload carries the exact song title and
 * the right runtime, so it collects the title and duration bonuses and lands
 * only slightly negative — and "slightly negative" still wins when the real
 * release is missing from the results, which is how a movie scene ends up
 * playing. These are the shapes that are never a song release under any
 * reading, so they are removed from consideration instead.
 *
 * Word boundaries throughout: `\bclip\b` must not fire on the artist Clipse,
 * and `\bscene\b` must not fire on "scenery". The wanted-title exemption still
 * applies on top — a track Spotify calls "Love Scene" vetoes nothing.
 */
const VETO_TITLE: readonly RegExp[] = [
  /\bscene\b/iu,
  /\bscenes\b/iu,
  /\bclip\b/iu,
  /\bclips\b/iu,
  /\bdialogue\b/iu,
  /\bshorts\b/iu,
  /\btrailer\b/iu,
  /\bteaser\b/iu,
  /\breaction\b/iu,
  /\breacts\b/iu,
  /\binterview\b/iu,
];

/** Phrases disqualifying wherever they appear, title or channel. */
const VETO_ANYWHERE: readonly RegExp[] = [
  /\bmovie\s+scenes?\b/iu,
  /\bfilm\s+scenes?\b/iu,
  /\btv\s+scenes?\b/iu,
  /\bmovie\s+clips?\b/iu,
  /\bfilm\s+clips?\b/iu,
  /\bfull\s+scene\b/iu,
  /\bfull\s+movie\b/iu,
  /\bfull\s+episode\b/iu,
  /\bbest\s+scenes?\b/iu,
];

/** Variants that mean a different recording rather than a different master. */
const HARD_VARIANTS = new Set([
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'remix',
  'acoustic',
  'unplugged',
  'mashup',
  'nightcore',
  'sped-up',
  'slowed',
  'reverb',
  'lofi',
]);

/**
 * Word-boundary patterns for the hard variants, scanned against raw titles.
 *
 * `identityOf` alone is not enough here. It strips a whole bracket group when
 * the group contains noise words, so "(Official Remix Audio)" loses its
 * `remix` marker along with the "official" and "audio" — and the remix then
 * looks identical to the original. Scanning the raw title recovers exactly
 * those, and the union of the two is what gets compared.
 */
const RAW_VARIANT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['remix', /\bremix(?:ed)?\b/iu],
  ['live', /\blive\b/iu],
  ['acoustic', /\bacoustic\b/iu],
  ['unplugged', /\bunplugged\b/iu],
  ['cover', /\bcover\b/iu],
  ['instrumental', /\binstrumental\b/iu],
  ['karaoke', /\bkaraoke\b/iu],
  ['sped-up', /\bsped[\s-]*up\b/iu],
  ['slowed', /\bslowed\b/iu],
  ['reverb', /\breverb\b/iu],
  ['mashup', /\bmash[\s-]?up\b/iu],
  ['lofi', /\blo[\s-]?fi\b/iu],
  ['nightcore', /\bnightcore\b/iu],
];

/**
 * Variant markers for one side of the comparison: what `identityOf` found,
 * plus anything the raw title still shows. Title only — a channel called
 * "Live Nation" does not make its uploads live recordings.
 */
function variantSet(variant: string | null, rawTitle: string): Set<string> {
  const marks = new Set(variant === null ? [] : variant.split('+'));
  for (const [mark, pattern] of RAW_VARIANT_PATTERNS) {
    if (pattern.test(rawTitle)) marks.add(mark);
  }
  marks.delete('');
  return marks;
}

/* ------------------------------------------------------------------ scoring */

/**
 * Score one candidate against the wanted recording.
 *
 * Positive is better; the scale is arbitrary but stable, and only comparisons
 * between candidates for the same track are meaningful.
 */
export function scoreCandidate<T extends MatchCandidate>(
  wanted: WantedTrack,
  candidate: T,
): ScoredCandidate<T> {
  const reasons: string[] = [];
  let authoritative = false;
  let score = 0;
  const add = (points: number, label: string): void => {
    if (points === 0) return;
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${String(Math.round(points))} ${label}`);
  };

  // A livestream is never a track release, and it has no duration to compare.
  if (candidate.isStream) {
    return { candidate, score: REJECT_BELOW - 100, reasons: ['stream'], authoritative: false };
  }

  // Disqualification happens before scoring: no combination of title, runtime
  // and channel should be able to rehabilitate a movie scene. Exempted when the
  // Spotify metadata carries the same word, so the release is never rejected
  // for matching its own name.
  const wantedRaw = `${wanted.title} ${wanted.artist} ${wanted.album ?? ''}`;
  const vetoed =
    VETO_TITLE.find((rule) => rule.test(candidate.title) && !rule.test(wantedRaw)) ??
    VETO_ANYWHERE.find(
      (rule) => rule.test(`${candidate.title} ${candidate.author}`) && !rule.test(wantedRaw),
    );
  if (vetoed !== undefined) {
    return {
      candidate,
      score: REJECT_BELOW - 100,
      reasons: [`vetoed:${vetoed.source.replace(/\\b|\\s\+/gu, ' ').trim()}`],
      authoritative: false,
    };
  }

  const wantedId = identityOf(wanted.artist, wanted.title);
  const candidateId = identityOf(candidate.author, candidate.title);
  const candidateText = flat(`${candidate.title} ${candidate.author}`);
  const titleText = flat(candidate.title);

  /* --- duration ------------------------------------------------------- */
  if (wanted.durationMs > 0 && candidate.durationMs > 0) {
    const diff = Math.abs(candidate.durationMs - wanted.durationMs);
    const ratio = candidate.durationMs / wanted.durationMs;
    const longer = candidate.durationMs > wanted.durationMs;
    if (diff <= 2_000) add(30, 'duration-exact');
    else if (diff <= 5_000) add(24, 'duration-close');
    else if (diff <= 12_000) add(15, 'duration-near');
    else if (ratio > 2.5 || ratio < 0.5) add(-45, 'duration-wrong');
    else if (longer && diff <= 75_000) {
      // An official music video is routinely a minute longer than the track:
      // label card, spoken intro, credits. Penalising that at full strength
      // ranked the real release below lyrics reuploads, which are cut to the
      // exact runtime precisely because they are just the audio.
      add(-4, 'longer-video-framing');
    } else if (!longer && diff <= 30_000) {
      // Short of the track is the more suspicious direction: previews, edits
      // and clips all land here, and nothing legitimate is truncated.
      add(-14, 'duration-short');
    } else add(-20, 'duration-off');

    // A clip far shorter than the song, where the song is long enough that a
    // real upload could not be: shorts, previews, scene snippets.
    if (wanted.durationMs > 90_000 && candidate.durationMs < 70_000) {
      add(-35, 'too-short-for-track');
    }
  }

  /* --- title ---------------------------------------------------------- */
  const wantedTitleWords = words(wantedId.titleKey);
  if (candidateId.titleKey === wantedId.titleKey) {
    add(30, 'title-exact');
  } else if (
    wantedId.titleKey.length > 0 &&
    (candidateId.titleKey.includes(wantedId.titleKey) ||
      wantedId.titleKey.includes(candidateId.titleKey))
  ) {
    add(18, 'title-contains');
  } else if (wantedTitleWords.length > 0) {
    const present = wantedTitleWords.filter((word) => titleText.includes(word)).length;
    const overlap = present / wantedTitleWords.length;
    if (overlap >= 0.99) add(20, 'title-all-words');
    else if (overlap >= 0.6) add(Math.round(overlap * 16), 'title-partial');
    else add(-32, 'title-mismatch');
  }

  /* --- artist --------------------------------------------------------- */
  const names = artistNames(wanted.artist);
  const channel = flat(candidate.author);
  // "DuaLipaVEVO" flattens to "dualipavevo", which does not contain "dua lipa".
  // Channel names run words together far more often than titles do, so the
  // space-stripped form is the one that actually matches them.
  const squashedChannel = channel.replace(/\s+/gu, '');
  const artistInChannel = names.some(
    (name) => channel.includes(name) || squashedChannel.includes(name.replace(/\s+/gu, '')),
  );
  const artistInTitle = names.some((name) => titleText.includes(name));
  if (candidateId.artistKey === wantedId.artistKey && wantedId.artistKey.length > 0) {
    add(20, 'artist-exact');
    authoritative = true;
  } else if (artistInChannel) {
    add(16, 'artist-in-channel');
  } else if (artistInTitle) {
    add(10, 'artist-in-title');
  } else {
    add(-14, 'artist-absent');
  }

  /* --- channel authority ---------------------------------------------- */
  // "<Artist> - Topic" is YouTube's own auto-generated music upload: the
  // closest thing to a guarantee that this is the release and not a video
  // about it. VEVO is the label-operated equivalent.
  if (/\s-\s*topic$/iu.test(candidate.author.trim())) {
    add(26, 'topic-channel');
    authoritative = true;
  } else if (/vevo/iu.test(candidate.author)) {
    add(24, 'vevo-channel');
    authoritative = true;
  } else if (artistInChannel && /official/iu.test(candidate.author)) {
    add(18, 'official-artist-channel');
    authoritative = true;
  }
  // Deliberately narrow. "<Something> Music" is what half the reupload and
  // lyrics channels on YouTube are called, and a channel merely containing
  // "Official" is usually an aggregator claiming the word — "OfficialMovie-
  // Soundtrack" outranked the artist's own upload on this bonus alone. The
  // signals that actually attribute an upload (Topic, VEVO, the artist's name)
  // are handled above and set `authoritative`; this is only for labels.
  else if (/\brecords\b|\brecordings\b/iu.test(candidate.author)) add(6, 'label-channel');

  /* --- release keywords ------------------------------------------------ */
  // Highest tier only: "Official Music Video (Official Audio)" should not
  // collect both, and a title stuffed with the word should not outrank a
  // Topic upload that says nothing at all.
  const tier = QUALITY_TIERS.find(([phrase]) => hasPhrase(titleText, phrase));
  if (tier !== undefined) add(tier[1], tier[2]);

  /* --- variant agreement ----------------------------------------------- */
  const wantedVariants = variantSet(wantedId.variant, wanted.title);
  const candidateVariants = variantSet(candidateId.variant, candidate.title);
  const introduced = [...candidateVariants].filter((mark) => !wantedVariants.has(mark));
  const missing = [...wantedVariants].filter((mark) => !candidateVariants.has(mark));
  const introducedHard = introduced.filter((mark) => HARD_VARIANTS.has(mark));
  const missingHard = missing.filter((mark) => HARD_VARIANTS.has(mark));

  if (introducedHard.length > 0) {
    // Spotify named the studio recording and this is the live/cover/remix.
    add(-38, `unwanted-${introducedHard.join('+')}`);
  }
  if (missingHard.length > 0) {
    // Spotify named the live/remix version and this is the plain one. Weighted
    // near the opposite case on purpose: playing the original when the remix
    // was asked for is the same kind of wrong, and a Topic upload of the
    // original otherwise outscores the correct remix on channel alone.
    add(-32, `missing-${missingHard.join('+')}`);
  }
  if (introduced.length === 0 && missing.length === 0) {
    add(10, wantedVariants.size > 0 ? 'variant-agrees' : 'no-variant');
  }
  // "cover by X" survives identityOf when the word is bare in running text.
  if (hasPhrase(titleText, 'cover by') && !wantedVariants.has('cover')) add(-30, 'cover-by');

  /* --- album ------------------------------------------------------------ */
  // Deliberately small. For a soundtrack the album name IS the film name, so
  // this is exactly the signal that would reward a movie scene; it is worth a
  // nudge between otherwise-tied candidates and nothing more.
  const album = wanted.album ?? null;
  // A single is usually released on an album of the same name, so matching it
  // would just be the title bonus a second time.
  if (
    album !== null &&
    album.length > 2 &&
    flat(album) !== flat(wanted.title) &&
    candidateText.includes(flat(album))
  ) {
    add(5, 'album-named');
  }

  /* --- junk -------------------------------------------------------------- */
  // A phrase the Spotify metadata itself contains is not evidence of anything:
  // songs are called "Love Scene", albums are called "Part 2", and a soundtrack
  // album is named after its film. Penalising those would reject the release
  // for matching its own title, which is the opposite of the intent.
  const wantedText = flat(`${wanted.title} ${wanted.artist} ${wanted.album ?? ''}`);
  for (const [phrase, penalty] of JUNK_PATTERNS) {
    if (hasPhrase(wantedText, phrase)) continue;
    if (hasPhrase(candidateText, phrase)) add(penalty, `junk:${phrase.replace(/\s+/gu, '-')}`);
  }

  // Attribution is the strongest evidence available and, until this, carried
  // only the weight of its channel bonus. A lyrics reupload is cut to the
  // track's exact runtime — precisely because it is only the audio — so it
  // collects the full duration bonus that an official video, with its intro
  // and credits, cannot. Without this the reupload wins on runtime alone.
  if (authoritative) add(15, 'artist-attributed');

  reasons.sort((a, b) => Math.abs(Number.parseInt(b, 10)) - Math.abs(Number.parseInt(a, 10)));
  return { candidate, score, reasons, authoritative };
}

/**
 * Rank candidates best-first. Ties break toward the closer duration, so two
 * uploads that look identical on paper resolve to the one nearer the release.
 */
export function rankCandidates<T extends MatchCandidate>(
  wanted: WantedTrack,
  candidates: readonly T[],
): readonly ScoredCandidate<T>[] {
  return candidates
    .map((candidate) => scoreCandidate(wanted, candidate))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (
        Math.abs(a.candidate.durationMs - wanted.durationMs) -
        Math.abs(b.candidate.durationMs - wanted.durationMs)
      );
    });
}

/**
 * The search strings to try, in order, cheapest-likeliest first.
 *
 * The caller is expected to stop as soon as a candidate clears
 * {@link CONFIDENT_SCORE}, so for the ordinary track this list costs exactly
 * one search — the plain query, which is what the old code sent. The rest exist
 * for the cases that query gets wrong, and are only paid for there.
 */
export function queryPlan(wanted: WantedTrack): readonly string[] {
  const lead = artistNames(wanted.artist)[0] ?? wanted.artist;
  const plain = `${wanted.title} ${wanted.artist}`.trim();
  const plans = [
    plain,
    `${wanted.title} ${lead} official audio`,
    `${wanted.title} ${lead} official music video`,
    `${wanted.title} ${lead} topic`,
    `${wanted.title} ${lead} official song`,
  ];
  // A distinct lead artist is worth one more attempt: collaborations are often
  // uploaded under the lead alone, and the joined string matches nothing.
  if (flat(lead) !== flat(wanted.artist)) plans.push(`${wanted.title} ${lead}`);
  return [...new Set(plans.map((plan) => plan.trim()).filter((plan) => plan.length > 0))];
}

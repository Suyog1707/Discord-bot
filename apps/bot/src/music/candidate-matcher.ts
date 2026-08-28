/**
 * Deciding which playable upload actually IS the canonical recording.
 *
 * This is question two of the two the resolver asks (see `canonical-track.ts`).
 * By the time anything here runs, the song is already known — title, artists,
 * album, runtime and, where a catalogue exposed it, an ISRC. The job is no
 * longer "find something that looks relevant" but "prove this upload is that
 * recording, or refuse it".
 *
 * The refusal half is the point. Search on any provider returns *something* for
 * any query, and the thing it returns for a soundtrack is the film scene, for a
 * hit is the reaction video, and on SoundCloud for anything popular is a sped-up
 * bootleg. All of those are legitimate search results and none of them are the
 * song, so the matcher is built to reject rather than to settle: a candidate
 * that cannot clear the bar produces no playback at all, and the caller moves to
 * the next provider or tells the user honestly that nothing matched.
 *
 * Three mechanisms, in increasing order of how much they know:
 *
 *   1. **Vetoes.** Shapes that are never a music release under any reading —
 *      livestreams, trailers, reactions, full movies. Removed from consideration
 *      before scoring, because no combination of title and runtime should be
 *      able to rehabilitate a movie scene.
 *   2. **Scoring.** Weighted evidence: ISRC, title, artist, duration, source
 *      attribution, version agreement, album. Weights live in `match-config.ts`
 *      and differ per provider.
 *   3. **Structural rejection.** The case keyword lists cannot catch — a scene
 *      upload with a perfectly clean title. Nothing in its text gives it away,
 *      so it is caught by the *combination* of weak signals: no attribution,
 *      wrong runtime, a channel that looks like a film channel, a soft junk
 *      phrase. Any one is noise; three at once is not a song.
 *
 * Provider-agnostic throughout: a `MatchCandidate` is whatever a playback
 * provider found, and SoundCloud and YouTube differ only by the weights they
 * are scored with.
 */
import { identityOf } from '../ai/identity.js';
import { joinedArtists, normaliseIsrc, type CanonicalTrack } from './canonical-track.js';
import {
  LABEL_CHANNEL_TOKENS,
  RELEASE_TIERS,
  type DurationRules,
  type MatchWeights,
} from './match-config.js';

/** Which playback provider produced a candidate. */
export type PlaybackProvider = 'soundcloud' | 'youtube';

/**
 * One playable upload, as a playback provider describes it.
 *
 * `description` is declared because the rejection rules are written to use it
 * where it exists — Lavalink does not currently expose one for either provider,
 * so in practice it is always absent and the text rules see title and uploader
 * only. Declaring it keeps the rule set honest about what it would consult
 * rather than silently pretending description data was consulted.
 */
export interface MatchCandidate {
  readonly title: string;
  /** YouTube channel, SoundCloud uploader — whoever posted it. */
  readonly author: string;
  readonly durationMs: number;
  readonly isStream: boolean;
  /**
   * Provider-scoped id. For SoundCloud this is the media URL itself, which is
   * what makes {@link SNIPPET_STREAM} detectable before playback rather than
   * four seconds into it.
   */
  readonly identifier: string;
  /** The upload's public page, when the provider gives one. */
  readonly uri?: string | null;
  readonly isrc?: string | null;
  readonly album?: string | null;
  readonly description?: string | null;
}

/** Why a candidate was removed from consideration entirely. */
export interface Rejection {
  readonly kind: 'stream' | 'snippet' | 'non-music' | 'duration' | 'unrelated' | 'isrc-conflict';
  /** Human-readable specifics, for the resolution log. */
  readonly detail: string;
}

export interface ScoredCandidate<T extends MatchCandidate = MatchCandidate> {
  readonly candidate: T;
  readonly score: number;
  /** Signed contributions, largest magnitude first — for the resolution log. */
  readonly reasons: readonly string[];
  /**
   * The upload is attributable to the artist — a Topic or VEVO channel, an
   * official artist channel, or an uploader whose name IS the artist.
   *
   * Tracked separately from the score because score alone cannot express it: a
   * well-titled reupload with the right runtime scores about as well as a real
   * release, and both the confidence check and the low-band attribution
   * requirement need to tell those apart.
   */
  readonly authoritative: boolean;
  /** Set when the candidate was vetoed; `score` is then a sentinel, not evidence. */
  readonly rejected: Rejection | null;
}

export interface MatchOptions {
  readonly provider: PlaybackProvider;
  readonly weights: MatchWeights;
  readonly duration: DurationRules;
  /**
   * Version markers the user explicitly asked for. A remix is only a wrong
   * answer when nobody wanted a remix.
   */
  readonly requestedVariants?: ReadonlySet<string> | undefined;
  /** Extra uploader tokens that mark a rights-holder, from configuration. */
  readonly officialChannelTokens?: readonly string[] | undefined;
}

/** Score assigned to a vetoed candidate. Far below any real threshold. */
export const REJECTED_SCORE = -1_000;

/**
 * A media URL that serves a snippet rather than the recording.
 *
 * SoundCloud publishes a 30-second `/preview/` stream instead of `/stream` for
 * tracks it will not hand to an unauthenticated client — Go+ titles and
 * some rights-restricted uploads. The track metadata is unaffected: it still
 * advertises the full 258-second runtime, so every duration check passes and
 * nothing looks wrong until the audio stops half a minute in.
 *
 * This is not a rare edge. It is specifically the ARTIST'S OWN uploads that are
 * served as previews, while a stranger's reupload of the same song gets the
 * full stream — so the matcher's own preference for attributed uploads walked
 * straight into it, and the better the match looked, the more likely it was a
 * snippet. Three or four of every ten SoundCloud results for a mainstream
 * Western track are previews.
 *
 * Detected before playback because it is visible in the identifier, and vetoed
 * rather than penalised: a snippet cannot become the song no matter how well
 * everything else about it matches.
 */
const SNIPPET_STREAM = /\/preview\//iu;

/* --------------------------------------------------------------- normalising */

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

/** `["official","audio"]` → matches "official audio" as an ordered phrase. */
function hasPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(flat(phrase));
}

/**
 * Artists as separate flattened names. A YouTube or SoundCloud upload usually
 * credits only the lead, so matching *any* one of them is the correct test —
 * matching the joined "A, B & C" string matches nothing.
 */
function artistNames(track: CanonicalTrack): string[] {
  return track.artists.map((name) => flat(name)).filter((name) => name.length > 1);
}

/* -------------------------------------------------------------------- signals */

/**
 * Phrases that argue this is not the song. Soft: these are weights, and every
 * one of them appears in some legitimate title somewhere.
 */
const JUNK_PATTERNS: readonly (readonly [string, number])[] = [
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
  ['short film', -45],
  ['first look', -35],
  ['movie scene', -55],
  ['film scene', -55],
  ['best scene', -50],
  ['scene from', -50],
  ['full movie', -55],
  ['full episode', -50],
  ['episode', -30],
  ['dialogue', -45],
  ['scene', -45],
  ['clip', -40],
  // Bare "movie" and "film", handled as weights rather than vetoes precisely
  // because they are generic. A soundtrack upload legitimately names its film,
  // and the exemption below spares any candidate whose word the catalogue's own
  // title, artist or album already contains — so "Kesariya | Brahmastra" is
  // untouched while "Kesariya | Brahmastra Movie" pays. They also each add a
  // point of suspicion, which is what actually removes the cinematic uploads
  // that pair them with a wrong runtime and no attribution.
  ['movie', -30],
  ['film', -25],
  ['cinematic', -30],
  ['picturised', -30],
  ['picturized', -30],
  // Serialised uploads: a song is not published in parts.
  ['part 1', -35],
  ['part 2', -35],
  ['part 3', -35],
  // The picturised cut. In Indian releases especially this is the version that
  // opens on dialogue and reaches the song half a minute in — exactly the
  // "scene first, song later" complaint — while the standalone audio or music
  // video of the same track sits alongside it.
  ['full video', -35],
  ['video song', -30],
  // Compilations and mixes: real audio, wrong object.
  ['compilation', -40],
  ['jukebox', -40],
  ['all songs', -40],
  ['full album', -25],
  ['nonstop', -35],
  ['megamix', -35],
  ['mashup', -30],
  ['dj set', -40],
  ['live set', -35],
  ['mixtape', -25],
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
  // Re-encodes: the same song, the wrong recording.
  ['8d audio', -35],
  ['nightcore', -35],
  ['bass boosted', -30],
  ['speed up', -25],
];

/**
 * Title shapes that disqualify a candidate outright.
 *
 * Scoring alone was not enough here. A scene upload carries the exact song
 * title and often the right runtime, so it collects the title and duration
 * bonuses and lands only slightly negative — and "slightly negative" still
 * wins when the real release is missing from the results.
 *
 * Word boundaries throughout: `\bclip\b` must not fire on the artist Clipse and
 * `\bscene\b` must not fire on "scenery". The canonical-title exemption applies
 * on top, so a recording the catalogue calls "Love Scene" vetoes nothing.
 */
const VETO_TITLE: readonly RegExp[] = [
  /\bscenes?\b/iu,
  /\bclips?\b/iu,
  /\bdialogues?\b/iu,
  /\bshorts\b/iu,
  /\btrailer\b/iu,
  /\bteaser\b/iu,
  /\breaction\b/iu,
  /\breacts\b/iu,
  /\binterview\b/iu,
  /\bepisode\s*\d+\b/iu,
  /\bfull\s+movie\b/iu,
  /\bdeleted\s+scenes?\b/iu,
  /\bbehind\s+the\s+scenes?\b/iu,
];

/** Phrases disqualifying wherever they appear — title, uploader or description. */
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
  /\bweb\s+series\b/iu,
];

/**
 * Uploaders whose entire business is film and television excerpts.
 *
 * Never a veto on its own: plenty of legitimate music comes from channels with
 * "Films" or "Cinema" in the name, and in several industries the film company
 * IS the music rights-holder. It contributes one point of suspicion, and only
 * the accumulation of several rejects a candidate.
 */
const NON_MUSIC_CHANNEL: readonly RegExp[] = [
  /\bmovie\s*clips?\b/iu,
  /\bmovies?\b/iu,
  /\bcinemas?\b/iu,
  /\bscenes?\b/iu,
  /\bclips?\b/iu,
  /\btrailers?\b/iu,
  /\bshorts\b/iu,
  /\bcomedy\b/iu,
  /\breacts?\b/iu,
  /\breactions?\b/iu,
  /\btv\s*series\b/iu,
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
 * Word-boundary patterns for the variant markers, scanned against raw titles
 * and raw user queries.
 *
 * `identityOf` alone is not enough: it strips a whole bracket group when the
 * group contains noise words, so "(Official Remix Audio)" loses its `remix`
 * marker along with the "official" and "audio" — and the remix then looks
 * identical to the original. Scanning raw text recovers exactly those, and the
 * union of the two is what gets compared.
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
 * Version markers the user typed for themselves.
 *
 * "Song X remix" and "Song X live" are requests, not accidents. Without this
 * the resolver would penalise the very thing that was asked for and hand back
 * the studio original — the same class of silent substitution as playing a
 * scene, just in the other direction.
 */
export function requestedVariantsOf(rawQuery: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const [marker, pattern] of RAW_VARIANT_PATTERNS) {
    if (pattern.test(rawQuery)) found.add(marker);
  }
  return found;
}

/**
 * Variant markers for one side of the comparison: what `identityOf` found, plus
 * anything the raw title still shows. Title only — an uploader called "Live
 * Nation" does not make its uploads live recordings.
 */
function variantSet(variant: string | null, rawTitle: string): Set<string> {
  const marks = new Set(variant === null ? [] : variant.split('+'));
  for (const [mark, pattern] of RAW_VARIANT_PATTERNS) {
    if (pattern.test(rawTitle)) marks.add(mark);
  }
  marks.delete('');
  return marks;
}

/* ---------------------------------------------------------------- attribution */

interface Attribution {
  readonly points: number;
  readonly label: string;
  /** True when the platform, not the title, vouches for the upload. */
  readonly authoritative: boolean;
}

/**
 * How strongly the source vouches for this upload, best signal first.
 *
 * The tiers are ordered by how hard they are to fake. "<Artist> - Topic" is
 * generated by YouTube itself from a distributor's delivery; VEVO is
 * label-operated; an uploader that both names the artist and says "official" is
 * a claim the artist could have made; an uploader that merely IS the artist's
 * name is weaker still but is how most of SoundCloud is organised. A recognised
 * label token is last and small.
 *
 * Deliberately not a roster of company names. Operators extend the token list
 * through configuration rather than waiting for a code change when the bot
 * starts playing music from a market whose labels nobody listed.
 */
function attributionOf(
  candidate: MatchCandidate,
  artistNamesFlat: readonly string[],
  weights: MatchWeights,
  extraTokens: readonly string[],
): Attribution | null {
  const author = candidate.author.trim();
  const channel = flat(author);
  // "DuaLipaVEVO" flattens to "dualipavevo", which does not contain "dua lipa".
  // Uploader names run words together far more often than titles do, so the
  // space-stripped form is the one that actually matches them.
  const squashed = channel.replace(/\s+/gu, '');
  const namesArtist = artistNamesFlat.some(
    (name) => channel.includes(name) || squashed.includes(name.replace(/\s+/gu, '')),
  );

  if (weights.topicChannel > 0 && /\s-\s*topic$/iu.test(author)) {
    return { points: weights.topicChannel, label: 'topic-channel', authoritative: true };
  }
  if (weights.vevoChannel > 0 && /vevo/iu.test(author)) {
    return { points: weights.vevoChannel, label: 'vevo-channel', authoritative: true };
  }
  if (namesArtist && /official/iu.test(author)) {
    return {
      points: weights.officialArtistChannel,
      label: 'official-artist-channel',
      authoritative: true,
    };
  }
  if (namesArtist) {
    // The uploader is the artist and nothing else. On SoundCloud this is the
    // normal shape of a real release; on YouTube it is weaker but still real.
    return { points: weights.artistUploader, label: 'artist-uploader', authoritative: true };
  }

  const tokens = [...LABEL_CHANNEL_TOKENS, ...extraTokens];
  const matched = tokens.find((token) => token.length > 0 && channel.includes(flat(token)));
  if (matched !== undefined) {
    // A label upload is a real release but says nothing about *which* release,
    // so it earns points without earning attribution: a film company's channel
    // posts the song and the scene from the same account.
    return { points: weights.labelChannel, label: `label:${matched}`, authoritative: false };
  }
  return null;
}

/* -------------------------------------------------------------------- scoring */

/**
 * Score one candidate against the canonical recording.
 *
 * Positive is better. The scale is arbitrary but stable, and only comparisons
 * between candidates for the same track are meaningful.
 */
export function scoreCandidate<T extends MatchCandidate>(
  wanted: CanonicalTrack,
  candidate: T,
  options: MatchOptions,
): ScoredCandidate<T> {
  const { weights, duration: rules } = options;
  const reasons: string[] = [];
  let authoritative = false;
  let score = 0;
  const add = (points: number, label: string): void => {
    if (points === 0) return;
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${String(Math.round(points))} ${label}`);
  };
  const reject = (kind: Rejection['kind'], detail: string): ScoredCandidate<T> => ({
    candidate,
    score: REJECTED_SCORE,
    reasons: [`rejected:${kind}:${detail}`],
    authoritative: false,
    rejected: { kind, detail },
  });

  /* --- vetoes, before any scoring -------------------------------------- */

  // A livestream is never a track release, and it has no runtime to compare.
  if (candidate.isStream) return reject('stream', 'livestream');

  // A snippet stream advertises the full runtime and delivers thirty seconds.
  // Nothing later in this function can detect that, because every field it
  // would inspect describes the complete recording.
  if (SNIPPET_STREAM.test(candidate.identifier) || SNIPPET_STREAM.test(candidate.uri ?? '')) {
    return reject('snippet', 'preview stream (not the full recording)');
  }

  // Text a catalogue itself uses is not evidence of anything: songs are called
  // "Love Scene", albums are called "Part 2", and a soundtrack album is named
  // after its film. Vetoing on those would reject the release for matching its
  // own name — the exact opposite of the intent.
  const wantedRaw = `${wanted.title} ${joinedArtists(wanted)} ${wanted.album ?? ''}`;
  const candidateAll = [candidate.title, candidate.author, candidate.description ?? '']
    .filter((part) => part.length > 0)
    .join(' ');

  const vetoed =
    VETO_TITLE.find((rule) => rule.test(candidate.title) && !rule.test(wantedRaw)) ??
    VETO_ANYWHERE.find((rule) => rule.test(candidateAll) && !rule.test(wantedRaw));
  if (vetoed !== undefined) {
    return reject('non-music', vetoed.source.replace(/\\b|\\s\+|\\s\*/gu, ' ').trim());
  }

  /* --- identity --------------------------------------------------------- */

  const wantedId = identityOf(joinedArtists(wanted), wanted.title);
  const candidateId = identityOf(candidate.author, candidate.title);
  const candidateText = flat(`${candidate.title} ${candidate.author}`);
  const titleText = flat(candidate.title);
  const names = artistNames(wanted);

  // ISRC is the only identifier here that names a recording rather than
  // describing one. When both sides carry one, it settles the question in
  // whichever direction it points — which is why a conflict is a veto and not
  // merely a penalty: the rights-holder has stated these are different masters.
  const candidateIsrc = normaliseIsrc(candidate.isrc);
  const isrcMatched = wanted.isrc !== null && candidateIsrc !== null && wanted.isrc === candidateIsrc;
  if (wanted.isrc !== null && candidateIsrc !== null && !isrcMatched) {
    return reject('isrc-conflict', `${wanted.isrc} != ${candidateIsrc}`);
  }
  if (isrcMatched) add(weights.isrcMatch, 'isrc-match');

  /* --- duration --------------------------------------------------------- */

  const bothTimed = wanted.durationMs > 0 && candidate.durationMs > 0;
  let durationOutsideTolerance = false;
  if (bothTimed) {
    const diff = Math.abs(candidate.durationMs - wanted.durationMs);
    const ratio = candidate.durationMs / wanted.durationMs;
    const longer = candidate.durationMs > wanted.durationMs;
    durationOutsideTolerance = diff > rules.toleranceMs;

    // A candidate several times the length of the recording is a different
    // object entirely — a DJ set, a full album, an hour of "relaxing music", a
    // film. One a fraction of the length is an excerpt. Neither is the song,
    // and no amount of matching text makes it one.
    if (ratio > rules.maxRatio || ratio < rules.minRatio) {
      return reject(
        'duration',
        `${String(Math.round(candidate.durationMs / 1000))}s vs ${String(
          Math.round(wanted.durationMs / 1000),
        )}s`,
      );
    }

    if (diff <= rules.exactMs) add(weights.durationExact, 'duration-exact');
    else if (diff <= rules.closeMs) add(weights.durationClose, 'duration-close');
    else if (diff <= rules.toleranceMs) add(weights.durationNear, 'duration-near');
    else if (longer && diff <= rules.framingMs) {
      // An official music video is routinely a minute longer than the track:
      // label card, spoken intro, credits. Penalising that at full strength
      // ranks the real release below lyrics reuploads, which are cut to the
      // exact runtime precisely because they are only the audio.
      add(weights.durationFraming, 'longer-video-framing');
    } else if (!longer && diff <= 30_000) {
      // Short of the track is the more suspicious direction: previews, edits
      // and clips all land here, and nothing legitimate is truncated.
      add(weights.durationShort, 'duration-short');
    } else add(weights.durationOff, 'duration-off');

    // A clip far shorter than the song, where the song is long enough that a
    // real upload could not be: shorts, previews, scene snippets.
    if (wanted.durationMs > 90_000 && candidate.durationMs < 70_000) {
      add(weights.tooShortForTrack, 'too-short-for-track');
    }
  }

  /* --- title ------------------------------------------------------------ */

  // When no catalogue identified the track, the "title" is the whole typed
  // query — artist included — so the words have to be looked for across the
  // title AND the uploader. Searching the title alone would score "The Weeknd"
  // as missing from "Blinding Lights" and mismatch every correct result.
  const knownArtist = names.length > 0;
  const titleHaystack = knownArtist ? titleText : candidateText;

  const wantedTitleWords = words(wantedId.titleKey);
  let titleOverlap = 0;
  if (candidateId.titleKey === wantedId.titleKey) {
    titleOverlap = 1;
    add(weights.titleExact, 'title-exact');
  } else if (
    wantedId.titleKey.length > 0 &&
    (candidateId.titleKey.includes(wantedId.titleKey) ||
      wantedId.titleKey.includes(candidateId.titleKey))
  ) {
    titleOverlap = 0.9;
    add(weights.titleContains, 'title-contains');
  } else if (wantedTitleWords.length > 0) {
    const present = wantedTitleWords.filter((word) => titleHaystack.includes(word)).length;
    titleOverlap = present / wantedTitleWords.length;
    if (titleOverlap >= 0.99) add(weights.titleAllWords, 'title-all-words');
    else if (titleOverlap >= 0.6) add(Math.round(titleOverlap * weights.titlePartial), 'title-partial');
    else add(weights.titleMismatch, 'title-mismatch');
  }

  /* --- artist ----------------------------------------------------------- */

  const channel = flat(candidate.author);
  const squashedChannel = channel.replace(/\s+/gu, '');
  const artistInChannel = names.some(
    (name) => channel.includes(name) || squashedChannel.includes(name.replace(/\s+/gu, '')),
  );
  const artistInTitle = names.some((name) => titleText.includes(name));
  // With no known artist there is nobody to be absent: the artist signal is
  // unavailable rather than negative, and penalising every candidate equally
  // would only shift the whole field down.
  const artistAnywhere = knownArtist ? artistInChannel || artistInTitle : true;

  if (!knownArtist) {
    reasons.push('0 artist-unknown');
  } else if (candidateId.artistKey === wantedId.artistKey && wantedId.artistKey.length > 0) {
    add(weights.artistExact, 'artist-exact');
    authoritative = true;
  } else if (artistInChannel) {
    add(weights.artistInChannel, 'artist-in-channel');
  } else if (artistInTitle) {
    add(weights.artistInTitle, 'artist-in-title');
  } else {
    add(weights.artistAbsent, 'artist-absent');
  }

  /* --- source authority -------------------------------------------------- */

  const attribution = attributionOf(candidate, names, weights, options.officialChannelTokens ?? []);
  if (attribution !== null) {
    add(attribution.points, attribution.label);
    if (attribution.authoritative) authoritative = true;
  }

  /* --- release keywords --------------------------------------------------- */

  // Highest tier only, scaled per provider: "Official Music Video (Official
  // Audio)" is one signal, not two.
  const tier = RELEASE_TIERS.find(([phrase]) => hasPhrase(titleText, phrase));
  if (tier !== undefined) add(Math.round(tier[1] * weights.releaseTierScale), tier[2]);

  /* --- version agreement --------------------------------------------------- */

  // The user's explicit request joins the wanted set. Without this the resolver
  // would penalise "Song X remix" for being a remix — the catalogue may well
  // have matched the original, and the request is the more specific evidence.
  const requested = options.requestedVariants ?? new Set<string>();
  const wantedVariants = variantSet(wantedId.variant, wanted.title);
  for (const mark of requested) wantedVariants.add(mark);

  const candidateVariants = variantSet(candidateId.variant, candidate.title);
  const introduced = [...candidateVariants].filter((mark) => !wantedVariants.has(mark));
  const missing = [...wantedVariants].filter((mark) => !candidateVariants.has(mark));
  const introducedHard = introduced.filter((mark) => HARD_VARIANTS.has(mark));
  const missingHard = missing.filter((mark) => HARD_VARIANTS.has(mark));

  if (introducedHard.length > 0) {
    // The canonical recording is the studio master and this is the live take,
    // the cover or somebody's remix. Nobody asked for it.
    add(weights.variantUnrequested, `unwanted-${introducedHard.join('+')}`);
  }
  // Split by who asked. A variant the *user typed* is a direct statement of
  // intent and outweighs attribution; one inferred from catalogue metadata is
  // weaker evidence and gets the lighter penalty.
  const missingRequested = missingHard.filter((mark) => requested.has(mark));
  const missingCatalogue = missingHard.filter((mark) => !requested.has(mark));
  if (missingRequested.length > 0) {
    add(weights.variantRequestedMissing, `missing-requested-${missingRequested.join('+')}`);
  }
  if (missingCatalogue.length > 0) {
    add(weights.variantMissing, `missing-${missingCatalogue.join('+')}`);
  }
  if (introduced.length === 0 && missing.length === 0) {
    const agreedRequest = [...requested].filter((mark) => candidateVariants.has(mark));
    if (agreedRequest.length > 0) {
      add(weights.variantRequested, `requested-${agreedRequest.join('+')}`);
    } else {
      add(weights.variantAgrees, wantedVariants.size > 0 ? 'variant-agrees' : 'no-variant');
    }
  }
  // "cover by X" survives identityOf when the word is bare in running text.
  if (hasPhrase(titleText, 'cover by') && !wantedVariants.has('cover')) {
    add(weights.variantUnrequested, 'cover-by');
  }

  /* --- album -------------------------------------------------------------- */

  // Deliberately small. For a soundtrack the album name IS the film name, so
  // this is exactly the signal that would reward a movie scene; it is worth a
  // nudge between otherwise-tied candidates and nothing more.
  const album = wanted.album ?? null;
  const albumMatched =
    album !== null &&
    album.length > 2 &&
    // A single is usually released on an album of the same name, so matching it
    // would just be the title bonus a second time.
    flat(album) !== flat(wanted.title) &&
    (candidateText.includes(flat(album)) ||
      (candidate.album != null && flat(candidate.album) === flat(album)));
  if (albumMatched) add(weights.albumNamed, 'album-named');

  /* --- soft junk ----------------------------------------------------------- */

  const wantedText = flat(wantedRaw);
  let junkHits = 0;
  for (const [phrase, penalty] of JUNK_PATTERNS) {
    if (hasPhrase(wantedText, phrase)) continue;
    if (hasPhrase(candidateText, phrase)) {
      junkHits += 1;
      add(penalty, `junk:${phrase.replace(/\s+/gu, '-')}`);
    }
  }

  // Attribution is the strongest evidence available and, until this, carried
  // only the weight of its own bonus. A lyrics reupload is cut to the track's
  // exact runtime — precisely because it is only the audio — so it collects the
  // full duration bonus that an official video, with its intro and credits,
  // cannot. Without this the reupload wins on runtime alone.
  if (authoritative) add(weights.attributedBonus, 'artist-attributed');

  /* --- structural rejection ------------------------------------------------ */

  // The case no keyword list catches: a film excerpt uploaded under a clean
  // title. Nothing in its text gives it away, so it is caught by everything
  // being slightly wrong at once — an uploader that deals in clips, a runtime
  // that does not match the recording, no attribution to the artist, a soft
  // junk phrase. Any one of those is ordinary noise. Three together is not a
  // song, and an authoritative upload is exempt because the platform has
  // already vouched for it.
  const channelLooksNonMusic =
    NON_MUSIC_CHANNEL.some((rule) => rule.test(candidate.author)) &&
    !NON_MUSIC_CHANNEL.some((rule) => rule.test(wantedRaw));
  const suspicion =
    (junkHits > 0 ? 1 : 0) +
    (channelLooksNonMusic ? 1 : 0) +
    (durationOutsideTolerance ? 1 : 0) +
    (artistAnywhere ? 0 : 1) +
    (titleOverlap < 0.75 ? 1 : 0);
  if (!authoritative && suspicion >= 3) {
    return reject(
      'non-music',
      `composite(junk=${String(junkHits)} channel=${String(channelLooksNonMusic)} ` +
        `duration=${String(durationOutsideTolerance)} artist=${String(artistAnywhere)} ` +
        `title=${titleOverlap.toFixed(2)})`,
    );
  }

  // Unrelated: the words do not line up and nothing ties it to the artist. This
  // is the "similar title" trap stated as a rule — a shared word is not a match.
  if (titleOverlap < 0.34 && !artistAnywhere && !isrcMatched) {
    return reject('unrelated', `title-overlap=${titleOverlap.toFixed(2)}`);
  }

  reasons.sort((a, b) => Math.abs(Number.parseInt(b, 10)) - Math.abs(Number.parseInt(a, 10)));
  return { candidate, score, reasons, authoritative, rejected: null };
}

/**
 * Rank candidates best-first. Ties break toward the closer runtime, so two
 * uploads that look identical on paper resolve to the one nearer the release.
 */
export function rankCandidates<T extends MatchCandidate>(
  wanted: CanonicalTrack,
  candidates: readonly T[],
  options: MatchOptions,
): readonly ScoredCandidate<T>[] {
  return candidates
    .map((candidate) => scoreCandidate(wanted, candidate, options))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (
        Math.abs(a.candidate.durationMs - wanted.durationMs) -
        Math.abs(b.candidate.durationMs - wanted.durationMs)
      );
    });
}

/**
 * Whether a candidate is good enough to play.
 *
 * Two gates. The score gate is the configurable confidence threshold. The
 * attribution gate covers the band above it where text alone got a candidate
 * over the line: a scene upload carrying the song's exact title and runtime
 * scores respectably, and in that band the difference between it and the
 * release is that the release is attributable to the artist.
 */
export function isAcceptable(entry: ScoredCandidate | undefined, weights: MatchWeights): boolean {
  // Deliberately not a type predicate: narrowing the *negative* branch to
  // `undefined` would tell every caller that a rejected-but-present candidate
  // cannot exist, which is precisely the case they need to report on.
  if (entry === undefined) return false;
  if (entry.rejected !== null) return false;
  if (entry.score < weights.acceptScore) return false;
  return entry.authoritative || entry.score >= weights.attributionRequiredBelow;
}

/**
 * Whether a winner is good enough to stop searching. Strictly stronger than
 * {@link isAcceptable}: a later query might still find the official upload, and
 * only an already-attributed, high-scoring match makes that search pointless.
 */
export function isConfident(entry: ScoredCandidate | undefined, weights: MatchWeights): boolean {
  if (entry === undefined) return false;
  return entry.rejected === null && entry.score >= weights.confidentScore && entry.authoritative;
}

/**
 * The search strings to try, in order, cheapest-likeliest first.
 *
 * The caller stops as soon as a candidate is confident, so for an unambiguous
 * track this costs exactly one search. The rest exist for the tracks that first
 * query gets wrong — the soundtracks, the collaborations, the songs whose name
 * is also a film — and are only paid for there.
 *
 * **YouTube asks for lyrics, not for "official".** This is the difference
 * between the two providers' plans and it is the whole point of the fallback.
 * Searching "<song> official" returns official music videos, official *movie*
 * videos, picturised "full video" cuts and scene uploads — the entire class of
 * cinematic content that must not reach a voice channel — because that is what
 * all of them call themselves. A lyrics upload cannot be any of those: it is
 * the recording with text over it. Asking for lyrics first means the cheapest,
 * earliest queries return the cleanest candidates, and the broadening queries
 * below only run when they do not.
 *
 * Queries are unquoted. YouTube honours phrase quotes, and quoting a title the
 * uploader spelled slightly differently returns nothing at all — which on the
 * first query would push every track down the plan for no gain. Precision here
 * comes from scoring many candidates, not from constraining the search.
 */
export function queryPlan(wanted: CanonicalTrack, provider: PlaybackProvider): readonly string[] {
  const lead = wanted.primaryArtist;
  const joined = joinedArtists(wanted);
  const plain = `${wanted.title} ${joined}`.trim();
  const plans: string[] = [];

  if (provider === 'soundcloud') {
    // SoundCloud's index is thinner and its titles are plainer, so decorating
    // the query mostly returns nothing. Widening — dropping to the lead artist,
    // then to the bare title — is what finds the track there. No lyrics tier:
    // SoundCloud hosts audio, so every result is already "clean audio".
    plans.push(plain, `${wanted.title} ${lead}`, wanted.title);
    return dedupe(plans);
  }

  // The ISRC names the recording outright, and an ISRC is only ever attached to
  // an audio release — a scene upload cannot carry one. So this is both the
  // most precise query available and, like the lyrics queries, one that cannot
  // return cinematic content. It is not a keyword strategy and specifically not
  // the word "official"; it is exact identification, and it is free when a
  // catalogue supplied one.
  if (wanted.isrc !== null) plans.push(wanted.isrc);

  // Lyrics-focused, in order of how specifically each phrasing names a lyrics
  // upload.
  plans.push(
    `${wanted.title} ${lead} lyrics`,
    `${wanted.title} ${lead} lyric video`,
    `${wanted.title} ${lead} lyrics song`,
  );

  // Broadening, once the lyrics queries have not produced a confident match.
  // The plain query is first because it is the most faithful to what was asked;
  // "topic" targets YouTube's auto-generated art tracks, which are pure audio
  // and the next cleanest thing after a lyrics cut.
  plans.push(plain, `${wanted.title} ${lead} topic`);

  // Widest: title alone. Runs only when artist-qualified searching has failed
  // entirely, which usually means the upload credits somebody else.
  plans.push(`${wanted.title} lyrics`, wanted.title);

  return dedupe(plans);
}

function dedupe(plans: readonly string[]): readonly string[] {
  return [...new Set(plans.map((plan) => plan.trim()).filter((plan) => plan.length > 0))];
}

/**
 * Tunable knobs for candidate matching.
 *
 * Every weight, tolerance and threshold the matcher uses lives here rather than
 * being spelled inline at the point of use. That is not tidiness for its own
 * sake: the previous implementation had its numbers scattered across one very
 * long scoring function, so "SoundCloud should tolerate a looser artist match
 * than YouTube" was not expressible without forking the function, and "make the
 * duration tolerance ±15s" meant finding every place a duration was compared.
 *
 * Two profiles ship: one per playback provider. They differ because the
 * providers differ — YouTube has "- Topic" and VEVO channels that all but prove
 * attribution, SoundCloud has neither and instead puts the artist in the
 * uploader slot far more reliably than YouTube does.
 *
 * A handful of the knobs are also environment-overridable (see `env/index.ts`)
 * so a bad match can be tuned out in production without a deploy.
 */

/** How duration agreement is judged. All values are milliseconds. */
export interface DurationRules {
  /** Within this, the runtimes are the same recording. */
  readonly exactMs: number;
  /** Within this, close enough that nothing else needs to explain it. */
  readonly closeMs: number;
  /**
   * The configurable tolerance: still an acceptable match. Defaults to 12s,
   * inside the ±10–15s band that covers fade-outs, silent tails and the
   * half-second disagreements between catalogues.
   */
  readonly toleranceMs: number;
  /**
   * How much *longer* than the canonical runtime a candidate may be before it
   * stops looking like an official video with a label card and credits.
   */
  readonly framingMs: number;
  /** Above this ratio the candidate is a different object — a mix, a full album, a film. */
  readonly maxRatio: number;
  /** Below this ratio it is an excerpt — a clip, a short, a preview. */
  readonly minRatio: number;
}

/** Signed score contributions. Positive argues "this is the song". */
export interface MatchWeights {
  /* identity ------------------------------------------------------------- */
  /** Both sides carry the same ISRC. Decisive by design. */
  readonly isrcMatch: number;
  /** Both sides carry an ISRC and they differ: a different recording, stated by the rights-holder. */
  readonly isrcMismatch: number;

  /* title ---------------------------------------------------------------- */
  readonly titleExact: number;
  readonly titleContains: number;
  readonly titleAllWords: number;
  /** Scaled by the word-overlap ratio. */
  readonly titlePartial: number;
  readonly titleMismatch: number;

  /* artist --------------------------------------------------------------- */
  readonly artistExact: number;
  readonly artistInChannel: number;
  readonly artistInTitle: number;
  readonly artistAbsent: number;

  /* duration ------------------------------------------------------------- */
  readonly durationExact: number;
  readonly durationClose: number;
  readonly durationNear: number;
  /** Longer than the track but within `framingMs` — intro/outro, not a different object. */
  readonly durationFraming: number;
  /** Shorter than the track: previews, edits and clips all land here. */
  readonly durationShort: number;
  readonly durationOff: number;
  /** A long song against a very short candidate. */
  readonly tooShortForTrack: number;

  /* source authority ----------------------------------------------------- */
  /** YouTube's auto-generated "<Artist> - Topic": the platform's own attribution. */
  readonly topicChannel: number;
  readonly vevoChannel: number;
  /** A channel/uploader that both names the artist and calls itself official. */
  readonly officialArtistChannel: number;
  /** The uploader *is* the artist, with no other decoration. */
  readonly artistUploader: number;
  /** A recognised label / rights-holder. */
  readonly labelChannel: number;
  /** Applied once when any of the above established attribution. */
  readonly attributedBonus: number;

  /* release keywords ----------------------------------------------------- */
  /** Highest matching tier only — see `RELEASE_TIERS`. */
  readonly releaseTierScale: number;

  /* version agreement ---------------------------------------------------- */
  /** Candidate introduces a variant nobody asked for (remix/live/cover/…). */
  readonly variantUnrequested: number;
  /** The catalogue named a variant and this candidate is not it. */
  readonly variantMissing: number;
  /**
   * The *user typed* a variant and this candidate is not it.
   *
   * Heavier than `variantMissing` because it is a direct statement of intent
   * rather than an inference from catalogue metadata: someone who searched
   * "song x remix" and got the studio master got the wrong recording, however
   * official that master is.
   *
   * Calibrated to be just large enough to overturn full attribution — a Topic
   * upload of the original otherwise outscores any remix on channel alone — and
   * no larger, so that when the requested version genuinely does not exist the
   * original still lands fractionally above the accept threshold and plays.
   * Degrading to the right song is better than degrading to silence.
   */
  readonly variantRequestedMissing: number;
  /** Candidate and request agree about the version. */
  readonly variantAgrees: number;
  /** The user explicitly asked for this variant and the candidate has it. */
  readonly variantRequested: number;

  /* album ---------------------------------------------------------------- */
  readonly albumNamed: number;

  /* thresholds ----------------------------------------------------------- */
  /** Below this the candidate is not played, full stop. */
  readonly acceptScore: number;
  /** At or above this, stop searching — further queries cannot do better. */
  readonly confidentScore: number;
  /**
   * Below this score an unattributed upload is refused even though it cleared
   * `acceptScore`. A movie scene carrying the song's exact title and runtime
   * scores respectably on text alone; requiring attribution in that band is
   * what separates it from the release.
   */
  readonly attributionRequiredBelow: number;
}

export const DEFAULT_DURATION_RULES: DurationRules = {
  exactMs: 2_000,
  closeMs: 5_000,
  toleranceMs: 12_000,
  framingMs: 75_000,
  maxRatio: 2.5,
  minRatio: 0.5,
};

/**
 * YouTube. The strictest profile, because YouTube's catalogue is not a music
 * catalogue: everything in it that is *not* a song — the scenes, the trailers,
 * the reactions, the compilations — is competing for the same query.
 */
export const YOUTUBE_WEIGHTS: MatchWeights = {
  isrcMatch: 60,
  isrcMismatch: -50,

  titleExact: 30,
  titleContains: 18,
  titleAllWords: 20,
  titlePartial: 16,
  titleMismatch: -32,

  artistExact: 20,
  artistInChannel: 16,
  artistInTitle: 10,
  artistAbsent: -14,

  durationExact: 30,
  durationClose: 24,
  durationNear: 15,
  durationFraming: -4,
  durationShort: -14,
  durationOff: -20,
  tooShortForTrack: -35,

  topicChannel: 26,
  vevoChannel: 24,
  officialArtistChannel: 18,
  artistUploader: 14,
  labelChannel: 6,
  attributedBonus: 15,

  releaseTierScale: 1,

  variantUnrequested: -38,
  variantMissing: -32,
  variantRequestedMissing: -65,
  variantAgrees: 10,
  variantRequested: 14,

  albumNamed: 5,

  acceptScore: 55,
  confidentScore: 80,
  attributionRequiredBelow: 70,
};

/**
 * SoundCloud. Same shape, different emphasis.
 *
 * The uploader field is the artist far more often than YouTube's channel field
 * is, so attribution through it is weighted higher and "Topic"/VEVO — which do
 * not exist here — are inert. Against that, SoundCloud is where DJ sets, sped-up
 * edits and bootleg remixes live in bulk, so the version penalties are heavier:
 * an unrequested remix on SoundCloud is the most likely wrong answer there, the
 * way a movie scene is the most likely wrong answer on YouTube.
 *
 * Release keywords ("Official Audio") are rarer in SoundCloud titles and mean
 * less when present, hence the reduced tier scale.
 */
export const SOUNDCLOUD_WEIGHTS: MatchWeights = {
  ...YOUTUBE_WEIGHTS,

  artistExact: 24,
  artistInChannel: 22,
  artistInTitle: 10,
  artistAbsent: -18,

  topicChannel: 0,
  vevoChannel: 0,
  officialArtistChannel: 20,
  artistUploader: 20,
  labelChannel: 10,
  attributedBonus: 12,

  releaseTierScale: 0.6,

  variantUnrequested: -45,
  variantMissing: -32,
  variantRequestedMissing: -65,

  // Higher than YouTube's, which looks backwards until you notice what the
  // fallback is. Anything SoundCloud refuses gets asked of YouTube, where the
  // Topic and VEVO channels live — so a *demanding* primary does not cost
  // coverage, it just routes the doubtful cases to the catalogue that has the
  // official upload.
  //
  // Measured, not guessed. At 55, "Tum Hi Ho" resolved to a random SoundCloud
  // account's rip (68, unattributed) and stopped there; at 70 it falls through
  // and lands on the "Mithoon - Topic" upload (131). Meanwhile the artist's own
  // SoundCloud uploads — the case this provider ordering exists for — score
  // 96-126 and are untouched by the change.
  acceptScore: 70,
  confidentScore: 85,
  // Between `acceptScore` and this, an upload must be attributable to the
  // artist. SoundCloud has no platform-level marker like Topic, so this leans
  // on the uploader-name signals above; anything that clears neither is better
  // served by YouTube's official channels than by a stranger's reupload.
  attributionRequiredBelow: 85,
};

/**
 * Autoplay. Recommendations arrive as `artist — title` with no runtime, so the
 * duration signal — worth 30 points, the single largest positive — is simply
 * unavailable and every score lands correspondingly lower. The threshold moves
 * with it; the filtering and the vetoes do not change at all.
 */
export const AUTOPLAY_WEIGHTS: MatchWeights = {
  ...YOUTUBE_WEIGHTS,
  acceptScore: 30,
  confidentScore: 55,
  attributionRequiredBelow: 30,
};

/**
 * Title phrases that say what KIND of upload this is, best kind first.
 *
 * Only the highest matching tier is applied — "Official Music Video (Official
 * Audio)" is one signal, not two — and `.find()` returns the first match, so
 * array order decides which phrase is recognised as well as what it is worth.
 * More specific phrases must therefore precede the general ones they contain.
 *
 * The ordering is the content-type preference, and it deliberately does NOT
 * reward the word "official". "Official" is what a music video, a picturised
 * "full video", a movie clip and a scene compilation all call themselves, so
 * ranking on it steers straight into the cinematic content this whole system
 * exists to avoid. A lyrics upload is the opposite: it is the recording with
 * text over it, structurally incapable of being a scene.
 *
 * Preference, high to low:
 *
 *   1. Lyrics / lyric video — the recording, nothing else.
 *   2. Clean audio ("(Audio)", visualiser) — also just the recording.
 *   3. "Official audio" — audio-only, but scored under bare `audio` because
 *      the "official" half is the part that correlates with cinematic uploads.
 *   4. Music video — legitimate, least preferred; earns a token bonus so it
 *      still edges out an undescribed upload, never a decisive one.
 *   5. Anything else — no keyword bonus at all.
 *
 * This is a *content-type* axis only. Trust is scored separately as
 * attribution, so an artist's Topic upload can still outrank a stranger's
 * lyrics video — both are clean audio, and one of them is vouched for.
 */
export const RELEASE_TIERS: readonly (readonly [phrase: string, points: number, label: string])[] =
  [
    // Tier 1. Ordered longest-first so the specific phrasing is what gets named
    // in the log, though they are worth nearly the same.
    ['lyric video', 32, 'lyric-video'],
    ['lyrics video', 32, 'lyrics-video'],
    ['lyrics', 30, 'lyrics'],
    // Matches "lyrical" too, which is how half of South Asian music is titled.
    ['lyric', 28, 'lyric'],

    // Tier 3, before tier 2 in the array only because `audio` is a substring of
    // it: checked first so "Official Audio" is recognised as itself and scores
    // BELOW a bare "(Audio)" upload rather than inheriting its bonus.
    ['official audio', 16, 'official-audio'],

    // Tier 2. Clean audio with no cinematic surface.
    ['audio', 20, 'audio'],
    ['visualizer', 18, 'visualiser'],
    ['visualiser', 18, 'visualiser'],
    ['full song', 14, 'full-song'],

    // Tier 4. A real music video is a legitimate answer and the least preferred
    // one, so it is scored *negative* rather than merely small.
    //
    // Not a judgement about music videos as such — it is what "Official Video"
    // labels in practice. In Indian releases especially it is the picturised
    // cut: the one that opens on thirty seconds of dialogue before the song
    // starts, sits beside a "Full Video" of the same scene, and is a film
    // excerpt in everything but name. The penalty is sized to lose to a lyrics
    // or audio cut of the same song while still leaving an attributed music
    // video comfortably playable when it is the only thing that exists.
    ['official music video', -12, 'music-video'],
    ['music video', -12, 'music-video'],
    ['official video', -12, 'official-video'],
    // Ambiguous in the wild — sometimes audio, sometimes the video cut — so it
    // earns nothing either way and lets the other signals decide.
    ['official song', 0, 'official-song'],
  ];

/**
 * Tokens that mark an uploader as a label or rights-holder rather than a
 * random account.
 *
 * Deliberately generic and extensible instead of a list of company names: a
 * fixed roster is wrong the moment the bot plays music from a region whose
 * labels were not on it. Operators add their own through
 * `MATCH_OFFICIAL_CHANNELS`, which is merged with these at runtime.
 *
 * "music" is intentionally absent — half the reupload and lyrics channels on
 * YouTube are called "<Something> Music", and treating that as a rights-holder
 * signal is how an aggregator outranked an artist's own upload.
 */
export const LABEL_CHANNEL_TOKENS: readonly string[] = [
  'records',
  'recordings',
  'label',
  'entertainment',
  'official artist channel',
];

/** Environment-driven overrides applied on top of a base profile. */
export interface MatchOverrides {
  readonly durationToleranceMs?: number | undefined;
  readonly soundcloudAcceptScore?: number | undefined;
  readonly youtubeAcceptScore?: number | undefined;
}

/** Apply the operator's overrides to a profile pair. */
export function applyOverrides(overrides: MatchOverrides): {
  readonly soundcloud: MatchWeights;
  readonly youtube: MatchWeights;
  readonly duration: DurationRules;
} {
  const duration: DurationRules =
    overrides.durationToleranceMs === undefined
      ? DEFAULT_DURATION_RULES
      : {
          ...DEFAULT_DURATION_RULES,
          toleranceMs: overrides.durationToleranceMs,
          // The tighter bands stay proportional so a widened tolerance does not
          // leave "exact" meaning something stricter than the operator intended.
          closeMs: Math.min(DEFAULT_DURATION_RULES.closeMs, overrides.durationToleranceMs),
          exactMs: Math.min(DEFAULT_DURATION_RULES.exactMs, overrides.durationToleranceMs),
        };

  return {
    duration,
    soundcloud:
      overrides.soundcloudAcceptScore === undefined
        ? SOUNDCLOUD_WEIGHTS
        : { ...SOUNDCLOUD_WEIGHTS, acceptScore: overrides.soundcloudAcceptScore },
    youtube:
      overrides.youtubeAcceptScore === undefined
        ? YOUTUBE_WEIGHTS
        : { ...YOUTUBE_WEIGHTS, acceptScore: overrides.youtubeAcceptScore },
  };
}

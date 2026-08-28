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

  acceptScore: 55,
  confidentScore: 78,
  // SoundCloud has no platform-level attribution marker, so demanding one in a
  // wide band would reject most of the catalogue. The uploader-name signals
  // above already carry that weight.
  attributionRequiredBelow: 62,
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
 * Title phrases that argue this IS the release. Only the highest matching tier
 * is applied — "Official Music Video (Official Audio)" is one signal, not two,
 * and a title stuffed with the word must not outrank a Topic upload that says
 * nothing at all.
 */
export const RELEASE_TIERS: readonly (readonly [phrase: string, points: number, label: string])[] =
  [
    ['official audio', 22, 'official-audio'],
    ['official visualizer', 20, 'official-visualiser'],
    ['official music video', 20, 'official-music-video'],
    ['official video song', 18, 'official-video-song'],
    ['official video', 16, 'official-video'],
    ['official song', 16, 'official-song'],
    ['full song', 12, 'full-song'],
    // Above the lyric tiers and matched before them: a bare "(Audio)" upload is
    // the standalone recording by definition, while a lyrics channel tying with
    // the label's audio cut let the reupload win a coin toss.
    ['audio', 10, 'audio'],
    ['official', 9, 'official'],
    // A lyrics video is the recording with text over it: standalone song
    // content, never a scene, and the right answer when no official upload
    // surfaces. Kept just under `audio` so a label's cut wins the head-to-head.
    ['lyric video', 9, 'lyric-video'],
    ['lyrics', 8, 'lyrics'],
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
export function applyOverrides(
  overrides: MatchOverrides,
): { readonly soundcloud: MatchWeights; readonly youtube: MatchWeights; readonly duration: DurationRules } {
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

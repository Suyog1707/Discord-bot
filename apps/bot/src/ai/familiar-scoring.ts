/**
 * Ranking the music the room already knows.
 *
 * The discovery scorer in `scoring.ts` answers "does this sound like what is
 * playing?". That is the wrong question for a track somebody already put in
 * their library: the interesting question is "is THIS the familiar song to play
 * next?", and the evidence for it is completely different — how the track got
 * here (an explicit request beats a playlist entry beats a stray history row),
 * how often it has actually been finished, how long it has rested, and how many
 * of the people in the room have any claim on it.
 *
 * Pure, like every other scorer here: candidates and a context in, numbers out.
 * `now` is taken from the context rather than read from the clock, so a rest
 * curve can be tested at 3am on a Tuesday without waiting until Wednesday.
 *
 * Every component survives on the result. "Why did it play that again?" is the
 * question this module exists to answer — see `explainFamiliar`.
 */
import type { MusicSource } from '@discord-music/shared';

import { identityOf } from './identity.js';
import { languageFromTags, languageFromText } from './language.js';
import { dominantLanguage } from './scoring.js';
import type { RecentContext, TasteProfile } from './taste.js';

/** How a familiar candidate earned the label. Ordered by how much it is trusted. */
export type FamiliarSource = 'requested' | 'playlist' | 'library' | 'history';

export interface FamiliarCandidate {
  readonly title: string;
  readonly artist: string;
  /** 0 = unknown; the resolver treats a known duration as a strong match signal. */
  readonly durationMs: number;
  readonly uri: string | null;
  /** Last known provider id ('' if none). */
  readonly identifier: string;
  readonly source: MusicSource;
  readonly artworkUrl: string | null;
  readonly sources: ReadonlySet<FamiliarSource>;
  /** Total history plays, any origin. */
  readonly plays: number;
  /** Plays the listener explicitly chose (origin other than 'autoplay'). */
  readonly userPlays: number;
  /** Plays with completion >= 0.85 — the room let it run. */
  readonly completions: number;
  /** Skips with completion < 0.5 — the room rejected it. */
  readonly earlySkips: number;
  /** Epoch ms of the most recent play, or null when never played here. */
  readonly lastPlayedAt: number | null;
  /** Playlist relevance in [0,1] (favorite-starred / playCount normalised); 0 if none. */
  readonly playlistRelevance: number;
  /** Number of distinct listeners who have it in library/playlist/history. */
  readonly listenerCount: number;
  readonly tags?: readonly string[];
}

export interface FamiliarWeights {
  readonly source: number;
  readonly replay: number;
  readonly completion: number;
  readonly requested: number;
  readonly artistAffinity: number;
  readonly context: number;
  readonly recencyRest: number;
  /**
   * Reserved knob for playlist relevance. Zero by default because relevance is
   * already folded into the `source` signal (a starred, often-played playlist
   * makes its tracks count for more); it exists so an experiment can pull
   * playlists out as their own signal without changing this module's shape.
   */
  readonly playlist: number;
  readonly listeners: number;
}

/**
 * Spec defaults, summing to 1.0 across the active signals.
 *
 * Provenance leads: nothing else in this module is as strong a statement of
 * "play this" as a human having put the song somewhere on purpose.
 */
export const DEFAULT_FAMILIAR_WEIGHTS: FamiliarWeights = {
  source: 0.25,
  replay: 0.12,
  completion: 0.12,
  requested: 0.1,
  artistAffinity: 0.13,
  context: 0.15,
  recencyRest: 0.08,
  playlist: 0,
  listeners: 0.05,
};

export interface FamiliarScoringContext {
  /** Blended guild + listener taste. */
  readonly profile: TasteProfile;
  readonly recent: RecentContext;
  /** Session artist fatigue, 0..1 per artist key. */
  readonly artistFatigue?: ReadonlyMap<string, number>;
  /** Artist keys of the current seeds, newest first. */
  readonly seedArtists: readonly string[];
  /** Language the session has settled into, when one has. */
  readonly sessionLanguage?: string | null;
  /** Epoch ms. Passed in, never read from the clock — this module stays pure. */
  readonly now: number;
  readonly weights?: FamiliarWeights;
}

export interface ScoredFamiliar {
  readonly candidate: FamiliarCandidate;
  readonly trackKey: string;
  readonly artistKey: string;
  readonly score: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

/** How much each provenance is trusted, before playlist relevance is applied. */
const SOURCE_TRUST: Readonly<Record<FamiliarSource, number>> = {
  // Somebody typed this song into the bot. There is no stronger evidence.
  requested: 1,
  // Saved on purpose, for themselves.
  library: 0.9,
  // Saved on purpose, but possibly long ago and possibly as filler — relevance
  // of the containing playlist decides how much of the 0.8 actually lands,
  // but never enough of it that a playlist entry falls below a bare history
  // row: a person listed it, nobody merely happened to play it.
  playlist: 0.8,
  // Played here and survived the familiarity test upstream. Real, but weakest:
  // it may have been someone else's pick that nobody objected to.
  history: 0.55,
};

/**
 * Share of the playlist trust a track keeps in a playlist nobody stars or
 * plays. Chosen so 0.8 × floor clears history's 0.55: an unloved playlist is
 * still a list a person made.
 */
const PLAYLIST_FLOOR = 0.75;

/** Plays at which the replay signal saturates. Beyond this, more plays say little. */
const REPLAY_SATURATION = 6;
/** Explicit requests at which the "they ask for this" signal saturates. */
const REQUEST_SATURATION = 3;
/** Listeners at which the "this belongs to the room" signal saturates. */
const LISTENER_SATURATION = 3;

/** Below this a track has just played; resurfacing it is a bug, not a callback. */
const REST_FLOOR_MS = 2 * 60 * 60_000;
/** Above this the track is fully rested and costs nothing to play again. */
const REST_CEILING_MS = 24 * 60 * 60_000;
/** Never played *here*: fresh, but unverified — deliberately short of a full rest. */
const UNPLAYED_REST = 0.8;

/** Seeds beyond this position no longer carry a meaningful context claim. */
const SEED_HORIZON = 4;

/**
 * Score one familiar candidate.
 *
 * Positives are each in [0, 1], combined by the configured weights; penalties —
 * early skips, artist fatigue, a fresh skip of this exact track, a language the
 * session is not in — are then subtracted. The result is clamped to [0, 1] so
 * the planner can compare it to a plain score floor and to discovery scores
 * from `scoreCandidate`.
 */
export function scoreFamiliar(
  candidate: FamiliarCandidate,
  context: FamiliarScoringContext,
): ScoredFamiliar {
  const weights = context.weights ?? DEFAULT_FAMILIAR_WEIGHTS;
  const { profile, recent } = context;

  const identity = identityOf(candidate.artist, candidate.title);
  const artistKey = identity.artistKey;
  const trackKey = identity.key;
  const tags = candidate.tags ?? [];

  /* --- Positive signals ------------------------------------------------- */

  const source = scoreSource(candidate);

  const plays = nonNegative(candidate.plays);

  // Logarithmic: the jump from one play to two is the informative one; the jump
  // from nine to ten says nothing new about whether the room wants it.
  const replay = clamp01(Math.log1p(plays) / Math.log1p(REPLAY_SATURATION));

  // No plays is not a bad completion rate, it is no evidence — 0.5 is "no opinion".
  const completion = plays === 0 ? 0.5 : clamp01(nonNegative(candidate.completions) / plays);

  const requested = clamp01(nonNegative(candidate.userPlays) / REQUEST_SATURATION);

  const affinity = profile.artistAffinity[artistKey];
  const artistAffinity =
    affinity === undefined ? 0.5 : dampen(clamp01(0.5 + affinity / 2), profile.confidence);

  const contextFit = scoreContext(artistKey, tags, context);

  const recencyRest = scoreRest(candidate.lastPlayedAt, context.now);

  const listeners = clamp01(nonNegative(candidate.listenerCount) / LISTENER_SATURATION);

  const playlistRelevance = clamp01(candidate.playlistRelevance);

  const positive =
    weights.source * source +
    weights.replay * replay +
    weights.completion * completion +
    weights.requested * requested +
    weights.artistAffinity * artistAffinity +
    weights.context * contextFit +
    weights.recencyRest * recencyRest +
    weights.playlist * playlistRelevance +
    weights.listeners * listeners;

  /* --- Penalties -------------------------------------------------------- */

  const earlySkips = nonNegative(candidate.earlySkips);
  const completions = nonNegative(candidate.completions);
  // An early skip is an explicit rejection, and it does not stop mattering just
  // because the track is "familiar" — familiarity is how it got into the pool,
  // not permission to keep playing it.
  const skipRatePenalty = 0.25 * Math.min(1, earlySkips / 2);
  // Skipped more often than finished, more than once: the room has said no twice.
  const skipPatternPenalty = earlySkips > completions && earlySkips >= 2 ? 0.3 : 0;
  const skipPenalty = skipRatePenalty + skipPatternPenalty;

  const artistPenalty = 0.3 * clamp01(context.artistFatigue?.get(artistKey) ?? 0);

  // Skipped in THIS session: whatever the history says, right now it is wrong.
  const recentSkipPenalty = recent.skippedKeys.includes(trackKey) ? 0.4 : 0;

  const languagePenalty = scoreLanguagePenalty(candidate, tags, context);

  const score = clamp01(
    positive - skipPenalty - artistPenalty - recentSkipPenalty - languagePenalty,
  );

  return {
    candidate,
    trackKey,
    artistKey,
    score,
    breakdown: {
      source,
      replay,
      completion,
      requested,
      artistAffinity,
      context: contextFit,
      recencyRest,
      playlist: playlistRelevance,
      listeners,
      skipPenalty,
      artistPenalty,
      recentSkipPenalty,
      languagePenalty,
      final: score,
    },
  };
}

/**
 * Provenance: the best claim any source has on this track.
 *
 * Max rather than sum, because a song in both a library and a playlist is not
 * twice as wanted — it is wanted exactly as much as its strongest claim says.
 */
function scoreSource(candidate: FamiliarCandidate): number {
  let best = 0;
  for (const source of candidate.sources) {
    const trust =
      source === 'playlist'
        ? SOURCE_TRUST.playlist *
          (PLAYLIST_FLOOR + (1 - PLAYLIST_FLOOR) * clamp01(candidate.playlistRelevance))
        : SOURCE_TRUST[source];
    if (trust > best) best = trust;
  }
  return clamp01(best);
}

/**
 * How well the track fits what is playing right now.
 *
 * A seed artist is the strongest possible fit and decays with seed age: the song
 * that just played is a better reason to pick this track than one from five
 * songs ago. With no seed match, tags against the profile's own likes are the
 * fallback, and a tagless track gets 0.4 — slightly below neutral, because
 * "unknown fit" should lose a tie to "known fit" without being disqualified.
 */
function scoreContext(
  artistKey: string,
  tags: readonly string[],
  context: FamiliarScoringContext,
): number {
  const seedIndex = context.seedArtists.indexOf(artistKey);
  if (seedIndex !== -1) {
    const age = Math.min(seedIndex, SEED_HORIZON) / SEED_HORIZON;
    return clamp01(1 - 0.5 * age);
  }

  if (tags.length > 0) {
    const scores = tags.map((tag) => context.profile.tagAffinity[tag] ?? 0);
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    // Affinities are [-1, 1]; shift into [0, 1] with 0.5 as "no opinion", then
    // damp by confidence exactly as the discovery scorer does.
    return dampen(clamp01(0.5 + mean / 2), context.profile.confidence);
  }

  return 0.4;
}

/**
 * How rested the track is.
 *
 * Zero for two hours after a play — a favourite coming back inside the same
 * sitting is the single most complained-about autoplay failure — then a linear
 * ramp to fully rested at a day. A track never played in this guild starts high
 * but not maximal: it is fresh, but nobody has verified it lands here.
 */
function scoreRest(lastPlayedAt: number | null, now: number): number {
  if (lastPlayedAt === null) return UNPLAYED_REST;

  const elapsed = now - lastPlayedAt;
  if (!Number.isFinite(elapsed) || elapsed <= REST_FLOOR_MS) return 0;
  if (elapsed >= REST_CEILING_MS) return 1;
  return clamp01((elapsed - REST_FLOOR_MS) / (REST_CEILING_MS - REST_FLOOR_MS));
}

/**
 * The language penalty, mirroring `scoreCandidate`.
 *
 * A familiar track in the wrong language is still the wrong track: a Hindi room
 * that gets an English song out of somebody's old library has been interrupted,
 * not served. The title's script is checked before tags because it is free and
 * more reliable — nobody writes Devanagari by accident. Unknown language is
 * never punished; most titles and most tags say nothing about it.
 */
function scoreLanguagePenalty(
  candidate: FamiliarCandidate,
  tags: readonly string[],
  context: FamiliarScoringContext,
): number {
  const sessionLanguage = context.sessionLanguage ?? dominantLanguage(context.profile);
  if (sessionLanguage === null) return 0;

  const candidateLanguage =
    languageFromText(`${candidate.title} ${candidate.artist}`) ?? languageFromTags(tags);
  if (candidateLanguage === null || candidateLanguage === sessionLanguage) return 0;

  return 0.35;
}

/**
 * Human-readable reason a familiar track was chosen.
 *
 * For operators and `--debug`. When somebody asks why their favourite has not
 * come back yet, the answer is usually one number on this line.
 */
export function explainFamiliar(entry: ScoredFamiliar): string {
  const b = entry.breakdown;
  const parts = [
    `source ${format(b.source)}`,
    `replay ${format(b.replay)}`,
    `completion ${format(b.completion)}`,
    `requested ${format(b.requested)}`,
    `affinity ${format(b.artistAffinity)}`,
    `context ${format(b.context)}`,
    `rest ${format(b.recencyRest)}`,
    `listeners ${format(b.listeners)}`,
  ];
  const penalties = [
    penalty('skips', b.skipPenalty),
    penalty('artist', b.artistPenalty),
    penalty('skipped', b.recentSkipPenalty),
    penalty('language', b.languagePenalty),
  ].filter((part): part is string => part !== null);

  return `${entry.score.toFixed(3)} = ${parts.join(', ')}${
    penalties.length === 0 ? '' : ` | ${penalties.join(', ')}`
  }`;
}

function penalty(name: string, value: number | undefined): string | null {
  return value !== undefined && value > 0 ? `-${name} ${value.toFixed(2)}` : null;
}

function format(value: number | undefined): string {
  return (value ?? 0).toFixed(2);
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Blend a personal signal toward neutral when the profile is thin — the same
 * damping the discovery scorer applies, for the same reason: a guild with four
 * plays has no opinion worth acting on.
 */
function dampen(value: number, confidence: number): number {
  return 0.5 + (value - 0.5) * clamp01(confidence);
}

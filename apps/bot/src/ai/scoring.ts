/**
 * Ranking — the part that decides what actually plays.
 *
 * Deliberately pure: candidates in, scores out, no network and no database. All
 * the slow work happens upstream in candidate generation, so ranking several
 * hundred candidates is microseconds of arithmetic. That is what makes a
 * 300-track request a single pass rather than 300 round trips.
 *
 * Six positive signals, three penalties, one number. Every component is kept on
 * the result so "why was this song recommended?" has a real answer — see
 * `explainScore`.
 *
 * The weights below are a starting point, not physics. They are a plain object
 * so a guild, an experiment, or a future learned model can replace them without
 * touching the arithmetic.
 */
import { trackKeyOf as canonicalTrackKey, identityOf } from './identity.js';
import { languageFromTags } from './language.js';
import type { RecentContext, TasteProfile } from './taste.js';

/** Where a candidate came from. Affects how much its raw match score is trusted. */
export type CandidateOrigin =
  | 'similar-track'
  | 'similar-artist'
  | 'taste-artist'
  | 'discovery'
  | 'tag-chart'
  | 'youtube-mix'
  | 'history';

export interface Candidate {
  readonly title: string;
  readonly artist: string;
  readonly origin: CandidateOrigin;
  /** Source-reported similarity to the seed, 0–1. Tag charts report a flat 0.5. */
  readonly match: number;
  /** Tags known for this candidate, lowercased. Often empty — that is fine. */
  readonly tags?: readonly string[];
  /** Set when the candidate is already a playable track (mix / history seeds). */
  readonly identifier?: string;
}

export interface ScoringWeights {
  readonly similarity: number;
  readonly tagAffinity: number;
  readonly userAffinity: number;
  readonly moodFit: number;
  readonly novelty: number;
  readonly recentBehaviour: number;
}

/**
 * Spec defaults. Similarity leads because a recommendation that does not sound
 * like what is playing is wrong no matter how well it scores elsewhere.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  similarity: 0.25,
  tagAffinity: 0.2,
  userAffinity: 0.2,
  moodFit: 0.15,
  novelty: 0.1,
  recentBehaviour: 0.1,
};

/** What the request asked for, as far as ranking is concerned. */
export interface ScoringContext {
  readonly profile: TasteProfile;
  readonly recent: RecentContext;
  /** Moods and genres from the parsed intent, lowercased. */
  readonly desiredTags?: readonly string[];
  /** Language the result should stay in, when one is established or requested. */
  readonly desiredLanguage?: string | null;
  /** Normalised artists the user explicitly excluded. */
  readonly excludedArtists?: readonly string[];
  /** Push novelty and the recency penalty up ("something I haven't heard"). */
  readonly avoidRecent?: boolean;
  /**
   * Session artist fatigue, 0..1 per artist key — 1 means "just played,
   * repeatedly". Adaptive: it decays as other artists play, so a favourite
   * comes back naturally instead of on a fixed every-N-songs rule.
   */
  readonly artistFatigue?: ReadonlyMap<string, number>;
  readonly weights?: ScoringWeights;
}

export interface ScoreBreakdown {
  readonly similarity: number;
  readonly tagAffinity: number;
  readonly userAffinity: number;
  readonly moodFit: number;
  readonly novelty: number;
  readonly recentBehaviour: number;
  readonly recencyPenalty: number;
  readonly artistPenalty: number;
  readonly skipPenalty: number;
  readonly languagePenalty: number;
  readonly final: number;
}

export interface ScoredCandidate {
  readonly candidate: Candidate;
  readonly artistKey: string;
  readonly trackKey: string;
  readonly breakdown: ScoreBreakdown;
}

/**
 * How much a source's own match number is worth.
 *
 * Last.fm's track-level similarity is a real measurement; a tag chart only says
 * "this is popular within this tag", which is a much weaker claim about fit.
 */
const ORIGIN_TRUST: Readonly<Record<CandidateOrigin, number>> = {
  'similar-track': 1,
  'similar-artist': 0.75,
  // A favourite artist's catalogue: strong prior on taste, no claim about
  // similarity to what is playing — the affinity signal carries the rest.
  'taste-artist': 0.7,
  // Neighbours of favourites the listener has never played. Trust is lowest of
  // the personalised sources by design: discovery earns its place through the
  // sequence selector's dedicated slots, not by outranking known-good picks.
  discovery: 0.6,
  'youtube-mix': 0.8,
  'tag-chart': 0.5,
  history: 0.6,
};

/** How far back a repeat still counts as a repeat. */
const RECENCY_WINDOW = 50;

/**
 * Canonical identity, delegated to the identity module so every stage of the
 * pipeline — candidate dedup, history exclusion, session state, resolved-track
 * dedup — agrees on what "the same song" means. Three different keys in three
 * different stages is exactly how the repeated-song bug survived scoring.
 */
export function trackKeyOf(artist: string, title: string): string {
  return canonicalTrackKey(artist, title);
}

/**
 * Score one candidate.
 *
 * Positives are each in [0, 1] and combine by the configured weights; penalties
 * are then subtracted. The result is clamped to [0, 1] so downstream code can
 * treat it as a plain confidence.
 */
export function scoreCandidate(candidate: Candidate, context: ScoringContext): ScoredCandidate {
  const weights = context.weights ?? DEFAULT_WEIGHTS;
  const { profile, recent } = context;

  const identity = identityOf(candidate.artist, candidate.title);
  const artistKey = identity.artistKey;
  const trackKey = identity.key;
  const tags = candidate.tags ?? [];

  // Where this candidate sits in recent play history. Matched by Lavalink
  // identifier when the candidate has one, and ALWAYS by canonical track key —
  // Last.fm candidates never carry an identifier, and matching only on
  // identifiers silently disabled every repeat-suppression signal below for
  // the entire recommender path. That was the repeated-song bug.
  const playedIndex = (() => {
    if (candidate.identifier !== undefined) {
      const byIdentifier = recent.identifiers.indexOf(candidate.identifier);
      if (byIdentifier !== -1) return byIdentifier;
    }
    return recent.trackKeys.indexOf(trackKey);
  })();

  /* --- Positive signals ------------------------------------------------- */

  const similarity = clamp01(candidate.match * ORIGIN_TRUST[candidate.origin]);

  // Tag affinity: how well this candidate's tags line up with what the listener
  // has historically finished. Averaged rather than summed so a heavily-tagged
  // track does not out-score a well-matched but sparsely-tagged one.
  const tagScores = tags.map((tag) => profile.tagAffinity[tag] ?? 0);
  const rawTagAffinity =
    tagScores.length === 0
      ? 0
      : tagScores.reduce((sum, value) => sum + value, 0) / tagScores.length;
  // Affinities are [-1, 1]; shift into [0, 1] with 0.5 as "no opinion".
  const tagAffinity = dampen(clamp01(0.5 + rawTagAffinity / 2), profile.confidence);

  const artistAffinity = profile.artistAffinity[artistKey];
  const userAffinity =
    artistAffinity === undefined
      ? 0.5
      : dampen(clamp01(0.5 + artistAffinity / 2), profile.confidence);

  const moodFit = scoreMoodFit(tags, context, artistKey);

  // Novelty rewards what this guild has not played recently.
  const novelty = playedIndex !== -1 ? 0 : context.avoidRecent === true ? 1 : 0.7;

  // Recent behaviour: the artists of the last few tracks are what the session
  // currently sounds like, and staying adjacent to them is the point of a radio.
  const recentIndex = recent.artists.indexOf(artistKey);
  const recentBehaviour =
    recentIndex === -1 ? 0.4 : clamp01(1 - recentIndex / Math.max(1, recent.artists.length));

  const positive =
    weights.similarity * similarity +
    weights.tagAffinity * tagAffinity +
    weights.userAffinity * userAffinity +
    weights.moodFit * moodFit +
    weights.novelty * novelty +
    weights.recentBehaviour * recentBehaviour;

  /* --- Penalties -------------------------------------------------------- */

  // A track played recently is heavily penalised, tapering with distance: the
  // song that just finished is far worse to repeat than one from an hour ago.
  // (Hard exclusion upstream should already have removed in-cooldown repeats;
  // this is defence in depth for anything that slipped past it.)
  const recencyPenalty =
    playedIndex === -1 ? 0 : 0.6 * (1 - Math.min(playedIndex, RECENCY_WINDOW) / RECENCY_WINDOW);

  // Consecutive plays by one artist are what makes autoplay feel broken.
  // Session fatigue is the primary signal when available (it decays as other
  // artists play); the history-position fallback covers callers without one.
  const fatigue = context.artistFatigue?.get(artistKey);
  const artistIndex = recent.artists.indexOf(artistKey);
  const positionPenalty =
    artistIndex === -1 ? 0 : 0.25 * (1 - Math.min(artistIndex, 10) / 10);
  const artistPenalty =
    fatigue === undefined ? positionPenalty : Math.max(positionPenalty, 0.3 * clamp01(fatigue));

  // An early skip is an explicit rejection. Nothing outweighs it.
  const skipPenalty =
    (candidate.identifier !== undefined && recent.skipped.includes(candidate.identifier)) ||
    recent.skippedKeys.includes(trackKey)
      ? 0.5
      : 0;

  // A candidate whose tags confidently name a DIFFERENT language than the
  // session's is near-disqualified, not nudged. Folded into moodFit alone it
  // was worth 0.4 × 0.15 ≈ 0.06 of the final score — a rounding error next to
  // similarity, which is exactly how an English track outranked every Hindi
  // one. Unknown language stays unpunished: most tags say nothing about it.
  const sessionLanguage = context.desiredLanguage ?? dominantLanguage(profile);
  const candidateLanguage = languageFromTags(tags);
  const languagePenalty =
    sessionLanguage !== null &&
    candidateLanguage !== null &&
    candidateLanguage !== sessionLanguage
      ? 0.35
      : 0;

  const final = clamp01(
    positive - recencyPenalty - artistPenalty - skipPenalty - languagePenalty,
  );

  return {
    candidate,
    artistKey,
    trackKey,
    breakdown: {
      similarity,
      tagAffinity,
      userAffinity,
      moodFit,
      novelty,
      recentBehaviour,
      recencyPenalty,
      artistPenalty,
      skipPenalty,
      languagePenalty,
      final,
    },
  };
}

/**
 * Mood, genre and language fit.
 *
 * Language is folded in here rather than given its own weight because it
 * behaves like a very strong mood: a Hindi listener getting an English track is
 * the same class of mistake as a study playlist getting a club banger, and it is
 * the failure this whole engine most needs to avoid.
 */
function scoreMoodFit(tags: readonly string[], context: ScoringContext, artistKey: string): number {
  const desired = context.desiredTags ?? [];
  const language = context.desiredLanguage ?? dominantLanguage(context.profile);

  let score = 0.5;
  let signals = 0;

  if (desired.length > 0) {
    const hits = desired.filter((want) =>
      tags.some((tag) => tag === want || tag.includes(want) || want.includes(tag)),
    ).length;
    score += (hits / desired.length) * 0.5;
    signals += 1;
  }

  if (language !== null && tags.length > 0) {
    const candidateLanguage = languageOf(tags);
    if (candidateLanguage === language) {
      score += 0.5;
    } else if (candidateLanguage !== null) {
      // A confidently *different* language is the strong negative. An unknown
      // one is merely uninformative and must not be punished as if it were wrong.
      score -= 0.4;
    }
    signals += 1;
  }

  // An artist the listener already favours is weak evidence of mood fit when
  // nothing else is known — better than guessing 0.5 on a tagless candidate.
  if (signals === 0) {
    const affinity = context.profile.artistAffinity[artistKey];
    if (affinity !== undefined) score = clamp01(0.5 + affinity / 2);
  }

  return clamp01(score);
}

/** The language a candidate's tags imply, or null when they say nothing. */
export function languageOf(tags: readonly string[]): string | null {
  return languageFromTags(tags);
}

/** The listener's main language, when one clearly dominates. */
export function dominantLanguage(profile: TasteProfile): string | null {
  let best: string | null = null;
  let bestShare = 0;
  for (const [language, share] of Object.entries(profile.languageAffinity)) {
    if (share > bestShare) {
      best = language;
      bestShare = share;
    }
  }
  // Below a clear majority the guild is genuinely mixed, and forcing a language
  // on a mixed room is worse than letting similarity decide.
  return bestShare >= 0.5 ? best : null;
}

/**
 * Select the final list, enforcing diversity.
 *
 * Ranking alone produces a list dominated by whichever artist the listener likes
 * most, because every one of their tracks scores well for the same reasons. The
 * cap scales with the request: two or three per artist across ten tracks, more
 * across three hundred, because a 300-track playlist holding one artist to two
 * songs would be a different and much stranger complaint.
 */
export function selectDiverse(
  scored: readonly ScoredCandidate[],
  count: number,
  options: { readonly enforceArtistDiversity?: boolean } = {},
): readonly ScoredCandidate[] {
  const ranked = [...scored].sort((a, b) => b.breakdown.final - a.breakdown.final);

  if (options.enforceArtistDiversity === false) return ranked.slice(0, count);

  const perArtistCap = Math.max(2, Math.ceil(count / 25));
  /**
   * The ceiling overflow may not cross.
   *
   * Overflow exists so a thin candidate pool yields a full queue instead of a
   * stub, but left unbounded it hands the whole queue to whichever artist had
   * the most candidates — which is the exact failure the cap was added to
   * prevent. Half the request is the compromise: a thin pool still fills most of
   * what was asked for, and no artist can ever own the majority of it.
   */
  const overflowCap = Math.max(perArtistCap, Math.ceil(count / 2));
  const perArtist = new Map<string, number>();
  const seenTracks = new Set<string>();
  const picked: ScoredCandidate[] = [];
  const overflow: ScoredCandidate[] = [];

  for (const entry of ranked) {
    if (picked.length >= count) break;
    if (seenTracks.has(entry.trackKey)) continue;

    const used = perArtist.get(entry.artistKey) ?? 0;
    if (used >= perArtistCap) {
      // Held back rather than dropped: if the pool is too thin to fill the
      // request diversely, a repeat artist still beats a short queue.
      overflow.push(entry);
      continue;
    }

    perArtist.set(entry.artistKey, used + 1);
    seenTracks.add(entry.trackKey);
    picked.push(entry);
  }

  for (const entry of overflow) {
    if (picked.length >= count) break;
    if (seenTracks.has(entry.trackKey)) continue;

    const used = perArtist.get(entry.artistKey) ?? 0;
    if (used >= overflowCap) continue;

    perArtist.set(entry.artistKey, used + 1);
    seenTracks.add(entry.trackKey);
    picked.push(entry);
  }

  return picked;
}

/** How a session's artist fatigue decays with each further track played. */
const SEQUENCE_FATIGUE_DECAY = Math.exp(-1 / 6);

export interface SequenceOptions {
  /** Session artist fatigue at the start of the sequence (0..1 per artist). */
  readonly artistFatigue?: ReadonlyMap<string, number>;
  /**
   * Share of picks that should be discoveries — artists the listener has no
   * history with. 0 disables; 0.15 means roughly one pick in seven.
   */
  readonly discoveryLevel?: number;
  /** Artist keys the listener already knows, for classifying discoveries. */
  readonly knownArtists?: ReadonlySet<string>;
}

/**
 * Sequence-aware selection: the smart-shuffle heart.
 *
 * `selectDiverse` ranks tracks independently, which quietly assumes the best
 * QUEUE is the top-N best SONGS. It is not: after two Weeknd tracks, a third is
 * a worse next song than a slightly lower-scoring Dua Lipa track. So this
 * selector simulates the session as it picks — each choice raises that artist's
 * fatigue, records its tags, and the NEXT choice is scored against that evolved
 * state. Same inputs, same output: deterministic and pure, like everything else
 * in this module. Variety comes from the state evolving, not from dice.
 *
 * Signals per slot, applied on top of the candidate's base score:
 *  - artist fatigue (start state + simulated picks, decaying as slots pass)
 *  - tag saturation (three chill-lofi tracks in a row is a rut, not a mood)
 *  - tag continuity (smooth transitions beat whiplash jumps — but only a
 *    confident mismatch is penalised, tagless candidates are not)
 *  - discovery slots (periodically prefer an artist the listener has never
 *    played, so the radio explores the taste neighbourhood instead of
 *    circling inside it)
 */
export function selectSequence(
  scored: readonly ScoredCandidate[],
  count: number,
  options: SequenceOptions = {},
): readonly ScoredCandidate[] {
  const ranked = [...scored].sort((a, b) => b.breakdown.final - a.breakdown.final);
  const discoveryLevel = clamp01(options.discoveryLevel ?? 0.15);
  const discoveryEvery = discoveryLevel > 0 ? Math.max(2, Math.round(1 / discoveryLevel)) : 0;
  const known = options.knownArtists ?? new Set<string>();

  // Hard backstop: even a thin pool may not hand one artist most of a batch.
  const perArtistCap = Math.max(2, Math.ceil(count / 8));

  const fatigue = new Map<string, number>(options.artistFatigue ?? []);
  const tagRecency: string[][] = []; // tags of the last few picks, newest last
  const perArtist = new Map<string, number>();
  const pickedKeys = new Set<string>();
  const picked: ScoredCandidate[] = [];

  while (picked.length < count) {
    const slot = picked.length;
    const isDiscoverySlot = discoveryEvery > 0 && slot > 0 && slot % discoveryEvery === 0;
    const previousTags = tagRecency.at(-1) ?? [];
    const recentTagWindow = tagRecency.slice(-3).flat();

    let best: ScoredCandidate | null = null;
    let bestValue = -Infinity;

    for (const entry of ranked) {
      if (pickedKeys.has(entry.trackKey)) continue;
      if ((perArtist.get(entry.artistKey) ?? 0) >= perArtistCap) continue;

      let value = entry.breakdown.final;

      value -= 0.35 * clamp01(fatigue.get(entry.artistKey) ?? 0);

      const tags = entry.candidate.tags ?? [];
      if (tags.length > 0 && recentTagWindow.length > 0) {
        // Saturation: how many of the last picks' tags this candidate repeats.
        const repeats = tags.filter((tag) => recentTagWindow.includes(tag)).length;
        const saturation = repeats / tags.length;
        if (saturation > 0.6) value -= 0.1 * saturation;

        // Continuity with the immediately previous pick. Small on purpose: a
        // gentle preference for coherent transitions, not a genre lock.
        if (previousTags.length > 0) {
          const overlap = tags.filter((tag) => previousTags.includes(tag)).length;
          value += overlap > 0 ? 0.06 * Math.min(1, overlap / 2) : -0.04;
        }
      }

      if (isDiscoverySlot && !known.has(entry.artistKey) && !fatigue.has(entry.artistKey)) {
        value += 0.15;
      }

      if (value > bestValue) {
        bestValue = value;
        best = entry;
      }
    }

    if (best === null) break; // pool exhausted

    picked.push(best);
    pickedKeys.add(best.trackKey);
    perArtist.set(best.artistKey, (perArtist.get(best.artistKey) ?? 0) + 1);
    tagRecency.push([...(best.candidate.tags ?? [])]);

    // The session moves on one track: everyone's fatigue fades a step, and the
    // artist just picked takes a full fresh dose.
    for (const [artist, value] of fatigue) fatigue.set(artist, value * SEQUENCE_FATIGUE_DECAY);
    fatigue.set(best.artistKey, Math.min(1.5, (fatigue.get(best.artistKey) ?? 0) + 1));
  }

  return picked;
}

/**
 * Human-readable reason a track was chosen.
 *
 * For operators and `--debug`, never shown to Discord users unless they ask:
 * a radio that explains its own arithmetic mid-playlist is a worse radio.
 */
export function explainScore(entry: ScoredCandidate): string {
  const b = entry.breakdown;
  const parts = [
    `similarity ${b.similarity.toFixed(2)}`,
    `tags ${b.tagAffinity.toFixed(2)}`,
    `affinity ${b.userAffinity.toFixed(2)}`,
    `mood ${b.moodFit.toFixed(2)}`,
    `novelty ${b.novelty.toFixed(2)}`,
    `recent ${b.recentBehaviour.toFixed(2)}`,
  ];
  const penalties = [
    b.recencyPenalty > 0 ? `-recency ${b.recencyPenalty.toFixed(2)}` : null,
    b.artistPenalty > 0 ? `-artist ${b.artistPenalty.toFixed(2)}` : null,
    b.skipPenalty > 0 ? `-skipped ${b.skipPenalty.toFixed(2)}` : null,
    b.languagePenalty > 0 ? `-language ${b.languagePenalty.toFixed(2)}` : null,
  ].filter((part): part is string => part !== null);

  return `${b.final.toFixed(3)} = ${parts.join(', ')}${
    penalties.length === 0 ? '' : ` | ${penalties.join(', ')}`
  }`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Blend a personal signal toward neutral when the profile is thin.
 *
 * A guild with four plays has no meaningful artist affinity, and letting that
 * accident drive a fifth of the score would lock the radio onto whatever
 * happened to be played first. At zero confidence every personal signal reads
 * 0.5 — no opinion — and only sharpens as real history accumulates.
 */
function dampen(value: number, confidence: number): number {
  return 0.5 + (value - 0.5) * clamp01(confidence);
}

/**
 * Recommendation-quality metrics.
 *
 * The point of these numbers is falsifiability: "smart shuffle" is a claim
 * about behaviour, and behaviour is measured, not asserted. The one that
 * matters most is `duplicateRecommendationRate` — the share of generated
 * recommendations the exclusion layer had to block as repeats. The pipeline is
 * designed so that duplicates are caught rather than served; this metric is
 * how a regression in that design becomes visible in a log line instead of a
 * user complaint.
 *
 * Pure arithmetic over the session store's counters — no I/O, trivially
 * testable, and safe to compute on every autoplay pass.
 */
import type { SessionOutcomes } from './session.js';

export interface AutoplayMetrics {
  /** Of everything recommended, how much actually started playing. */
  readonly playRate: number;
  /** Of autoplay picks that played, how many the listener cut off early. */
  readonly skipRate: number;
  /** Of autoplay picks that played, how many ran essentially to the end. */
  readonly completionRate: number;
  /** Repeats caught by the exclusion layer, per recommendation generated. */
  readonly duplicateRecommendationRate: number;
  /** Share of adjacent plays by the same artist in the recent session. */
  readonly sameArtistRepetitionRate: number;
}

export function computeAutoplayMetrics(
  outcomes: SessionOutcomes,
  recentArtists: readonly string[],
): AutoplayMetrics {
  const rate = (part: number, whole: number): number =>
    whole <= 0 ? 0 : Math.min(1, part / whole);

  let adjacentRepeats = 0;
  for (let index = 1; index < recentArtists.length; index += 1) {
    if (recentArtists[index] === recentArtists[index - 1]) adjacentRepeats += 1;
  }

  return {
    playRate: rate(outcomes.played, outcomes.recommended),
    skipRate: rate(outcomes.skipped, outcomes.played),
    completionRate: rate(outcomes.completed, outcomes.played),
    duplicateRecommendationRate: rate(outcomes.duplicatesBlocked, outcomes.recommended),
    sameArtistRepetitionRate: rate(adjacentRepeats, Math.max(1, recentArtists.length - 1)),
  };
}

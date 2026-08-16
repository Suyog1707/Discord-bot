import { describe, expect, it } from 'vitest';

import { computeAutoplayMetrics } from './metrics.js';
import type { SessionOutcomes } from './session.js';

const zeroOutcomes: SessionOutcomes = {
  recommended: 0,
  played: 0,
  completed: 0,
  skipped: 0,
  duplicatesBlocked: 0,
};

describe('computeAutoplayMetrics', () => {
  // Pure arithmetic over counters that all start at zero — division by zero
  // must read as "no signal yet" (0), never NaN, since this gets logged and
  // eventually dashboarded on every autoplay pass.
  it('returns all-zero rates for a fresh session, never NaN', () => {
    const metrics = computeAutoplayMetrics(zeroOutcomes, []);

    for (const value of Object.values(metrics)) {
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBe(0);
    }
  });

  // duplicateRecommendationRate is the headline number: the share of
  // generated recommendations the exclusion layer had to catch as repeats.
  it('computes the duplicate rate as blocked over recommended', () => {
    const outcomes: SessionOutcomes = { ...zeroOutcomes, recommended: 20, duplicatesBlocked: 5 };

    const metrics = computeAutoplayMetrics(outcomes, []);

    expect(metrics.duplicateRecommendationRate).toBeCloseTo(0.25, 5);
  });

  it('computes same-artist repetition as adjacent repeats over transitions', () => {
    // ['a','a','b','b','c']: adjacent repeats at (a,a) and (b,b) = 2, over 4
    // transitions between 5 plays.
    const metrics = computeAutoplayMetrics(zeroOutcomes, ['a', 'a', 'b', 'b', 'c']);

    expect(metrics.sameArtistRepetitionRate).toBeCloseTo(0.5, 5);
  });

  // Counters are independent increments (recommended/played/etc. are bumped
  // from different call sites), so a transient inconsistency — more played
  // than recommended — must still clamp to a sane rate rather than exceeding 1.
  it('clamps every rate to [0, 1] even when counters are inconsistent', () => {
    const outcomes: SessionOutcomes = { ...zeroOutcomes, recommended: 2, played: 10 };

    const metrics = computeAutoplayMetrics(outcomes, []);

    expect(metrics.playRate).toBeLessThanOrEqual(1);
    expect(metrics.playRate).toBeGreaterThanOrEqual(0);
  });
});

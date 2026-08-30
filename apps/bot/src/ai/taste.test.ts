import { describe, expect, it } from 'vitest';

import { blendProfiles, EMPTY_TASTE_PROFILE, originWeightOf, type TasteProfile } from './taste.js';

describe('originWeightOf', () => {
  const play = (origin: string, playedMs: number, skipped = false) => ({
    origin,
    skipped,
    playedMs,
    durationMs: 200_000,
  });

  it('counts user plays at full weight', () => {
    expect(originWeightOf(play('user', 10_000))).toBe(1);
    expect(originWeightOf(play('user', 200_000))).toBe(1);
  });

  // The anti-drift rule for the long-term profile: a play the recommender
  // chose says little about the person unless they reacted to it.
  it('discounts tolerated autoplay plays heavily', () => {
    expect(originWeightOf(play('autoplay', 100_000))).toBeLessThan(0.5);
  });

  it('keeps autoplay skips at full weight — rejection is real feedback', () => {
    expect(originWeightOf(play('autoplay', 5_000, true))).toBe(1);
  });

  it('gives a completed autoplay play more weight than a tolerated one', () => {
    const completed = originWeightOf(play('autoplay', 195_000));
    const tolerated = originWeightOf(play('autoplay', 100_000));
    expect(completed).toBeGreaterThan(tolerated);
    expect(completed).toBeLessThan(1);
  });
});

describe('blendProfiles', () => {
  const profileOf = (overrides: Partial<TasteProfile>): TasteProfile => ({
    ...EMPTY_TASTE_PROFILE,
    ...overrides,
  });

  it('returns the empty profile for no inputs', () => {
    expect(blendProfiles([])).toEqual(EMPTY_TASTE_PROFILE);
  });

  // The single-profile case has to be an identity, or blending a room of one
  // would quietly rewrite that listener's taste.
  it('returns a single profile essentially unchanged', () => {
    const profile = profileOf({
      artistAffinity: { drake: 0.5, arijit: -0.2 },
      tagAffinity: { pop: 0.3 },
      languageAffinity: { hindi: 0.7, english: 0.3 },
      completionRate: 0.62,
      sampleSize: 40,
      confidence: 1,
    });

    const blended = blendProfiles([{ profile, weight: 1 }]);

    expect(blended.artistAffinity.drake).toBeCloseTo(0.5);
    expect(blended.artistAffinity.arijit).toBeCloseTo(-0.2);
    expect(blended.tagAffinity.pop).toBeCloseTo(0.3);
    expect(blended.languageAffinity.hindi).toBeCloseTo(0.7);
    expect(blended.completionRate).toBeCloseTo(0.62);
    expect(blended.sampleSize).toBe(40);
    expect(blended.confidence).toBe(1);
  });

  it('averages affinities by weight times confidence', () => {
    const listener = profileOf({ artistAffinity: { drake: 1 }, confidence: 1, sampleSize: 25 });
    const guild = profileOf({ artistAffinity: { drake: -1 }, confidence: 0.5, sampleSize: 12 });

    const blended = blendProfiles([
      { profile: listener, weight: 1 },
      { profile: guild, weight: 0.6 },
    ]);

    // effective weights: 1 * 1 = 1, and 0.6 * 0.5 = 0.3 → (1 - 0.3) / 1.3.
    expect(blended.artistAffinity.drake).toBeCloseTo(0.7 / 1.3, 5);
    expect(blended.sampleSize).toBe(37);
  });

  // Confidence is what the scorer multiplies personal signals by, so a profile
  // that knows nothing must not be able to drag it down.
  it('lets a confident profile outweigh an empty one', () => {
    const known = profileOf({ artistAffinity: { drake: 1 }, confidence: 1 });

    const blended = blendProfiles([
      { profile: known, weight: 1 },
      { profile: EMPTY_TASTE_PROFILE, weight: 1 },
    ]);

    // The empty profile is floored at 0.05, not dropped: 1 / 1.05.
    expect(blended.artistAffinity.drake).toBeCloseTo(1 / 1.05, 5);
  });

  it('averages confidence, adds a small agreement bonus per extra evidenced profile, and caps at 1', () => {
    const blended = blendProfiles([
      { profile: profileOf({ confidence: 1 }), weight: 1 },
      { profile: profileOf({ confidence: 1 }), weight: 0.6 },
    ]);
    expect(blended.confidence).toBe(1);

    const thin = blendProfiles([{ profile: profileOf({ confidence: 0.5 }), weight: 0.6 }]);
    expect(thin.confidence).toBeCloseTo(0.5);

    // Three thin listeners do not add up to certainty: the mean stays thin.
    const crowd = blendProfiles([
      { profile: profileOf({ confidence: 0.35 }), weight: 1 },
      { profile: profileOf({ confidence: 0.35 }), weight: 1 },
      { profile: profileOf({ confidence: 0.35 }), weight: 1 },
    ]);
    expect(crowd.confidence).toBeCloseTo(0.45);
  });

  // Language is a share distribution; it only stays one if absent keys count
  // as zero rather than being ignored.
  it('keeps language shares normalised across profiles', () => {
    const hindi = profileOf({ languageAffinity: { hindi: 1 }, confidence: 1 });
    const english = profileOf({ languageAffinity: { english: 1 }, confidence: 1 });

    const blended = blendProfiles([
      { profile: hindi, weight: 1 },
      { profile: english, weight: 1 },
    ]);

    const total = Object.values(blended.languageAffinity).reduce((sum, share) => sum + share, 0);
    expect(total).toBeCloseTo(1);
    expect(blended.languageAffinity.hindi).toBeCloseTo(0.5);
  });
});

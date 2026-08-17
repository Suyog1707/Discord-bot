import { describe, expect, it } from 'vitest';

import { originWeightOf } from './taste.js';

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

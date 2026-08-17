import { describe, expect, it } from 'vitest';

import { selectAutoplaySeeds, type AnchorHistoryEntry } from './anchors.js';

function entry(
  title: string,
  origin: 'user' | 'autoplay',
  overrides: Partial<AnchorHistoryEntry> = {},
): AnchorHistoryEntry {
  return {
    title,
    author: `${title} Artist`,
    identifier: `id-${title}`,
    origin,
    skipped: false,
    ...overrides,
  };
}

/** Deterministic "random" that always picks the first remaining option. */
const first = (): number => 0;

describe('selectAutoplaySeeds', () => {
  // The spec's core scenario: user queued A B C D, autoplay played E F.
  // The next generation must be anchored on A–D; E/F may only be context.
  it('anchors on user plays and demotes autoplay plays to low-weight context', () => {
    const history = [
      entry('F', 'autoplay'),
      entry('E', 'autoplay'),
      entry('D', 'user'),
      entry('C', 'user'),
      entry('B', 'user'),
      entry('A', 'user'),
    ];

    const seeds = selectAutoplaySeeds(history, first);

    // Three full-weight anchors from the user's tracks, newest first as lead.
    const anchors = seeds.filter((seed) => (seed.weight ?? 1) >= 1);
    expect(anchors.length).toBe(3);
    expect(anchors[0]?.title).toBe('D');
    for (const anchor of anchors) {
      expect(['A', 'B', 'C', 'D']).toContain(anchor.title);
    }

    // Exactly one autoplay context seed — the newest — and it is discounted.
    const context = seeds.filter((seed) => (seed.weight ?? 1) < 1);
    expect(context).toHaveLength(1);
    expect(context[0]?.title).toBe('F');
    expect(context[0]?.weight).toBeLessThan(0.5);
  });

  it('keeps the lead anchor stable while the rest rotate', () => {
    const history = [
      entry('D', 'user'),
      entry('C', 'user'),
      entry('B', 'user'),
      entry('A', 'user'),
    ];

    const pickFirst = selectAutoplaySeeds(history, () => 0);
    const pickLast = selectAutoplaySeeds(history, () => 0.999);

    // The newest user track leads both selections (buffer identity stays
    // stable between generations)…
    expect(pickFirst[0]?.title).toBe('D');
    expect(pickLast[0]?.title).toBe('D');
    // …while the rotating tail differs with the draw.
    expect(pickFirst.map((seed) => seed.title)).not.toEqual(pickLast.map((seed) => seed.title));
  });

  it('never anchors on a skipped track', () => {
    const history = [entry('Skipped', 'user', { skipped: true }), entry('Kept', 'user')];

    const seeds = selectAutoplaySeeds(history, first);
    expect(seeds.map((seed) => seed.title)).not.toContain('Skipped');
    expect(seeds[0]?.title).toBe('Kept');
  });

  it('deduplicates repeated plays of the same song', () => {
    const history = [entry('A', 'user'), entry('A', 'user'), entry('B', 'user')];

    const seeds = selectAutoplaySeeds(history, first);
    expect(seeds.filter((seed) => seed.title === 'A')).toHaveLength(1);
  });

  // A window with no user plays at all (a session running on pure autoplay)
  // must not fabricate full-weight anchors out of the recommender's own
  // output — everything is context, and the taste profile does the anchoring.
  it('falls back to reduced-weight seeds when no user plays exist', () => {
    const history = [entry('E', 'autoplay'), entry('F', 'autoplay')];

    const seeds = selectAutoplaySeeds(history, first);
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) {
      expect(seed.weight ?? 1).toBeLessThan(1);
    }
  });

  it('returns nothing for empty history', () => {
    expect(selectAutoplaySeeds([], first)).toEqual([]);
  });
});

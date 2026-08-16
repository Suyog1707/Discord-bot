import { describe, expect, it } from 'vitest';

import { isPlausibleAlternative } from './track.js';

/**
 * The cases here are real: SoundCloud answers both "Banda Kaam Ka" and
 * "Aashiqana" with the *same* Revoic remix, which is exactly the substitution
 * the fallback must refuse.
 */
const original = {
  title: 'Banda Kaam Ka',
  author: 'Chaar Diwaari',
  durationMs: 180_000,
};

describe('isPlausibleAlternative', () => {
  it('accepts the same recording from another source', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Chaar Diwaari x Sanjith Hegde - Banda Kaam Ka',
        author: 'Def Jam India',
        durationMs: 182_000,
      }),
    ).toBe(true);
  });

  it('rejects a remix of the right song', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Chaar Diwaari - Banda Kaam Ka (Revoic Remix)',
        author: 'revoic',
        durationMs: 181_000,
      }),
    ).toBe(false);
  });

  it('rejects a different song by the same artist', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Aashiqana',
        author: 'Chaar Diwaari',
        durationMs: 179_000,
      }),
    ).toBe(false);
  });

  it('rejects a recording of a very different length', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Banda Kaam Ka',
        author: 'Chaar Diwaari',
        durationMs: 420_000,
      }),
    ).toBe(false);
  });

  it('allows a variant marker the original already claims', () => {
    expect(
      isPlausibleAlternative(
        { title: 'Banda Kaam Ka (Live)', author: 'Chaar Diwaari', durationMs: 180_000 },
        { title: 'Banda Kaam Ka - Live', author: 'Chaar Diwaari', durationMs: 185_000 },
      ),
    ).toBe(true);
  });

  it('matches when the source puts the artist in the title', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Banda Kaam Ka',
        author: 'Unknown Uploader',
        durationMs: 178_000,
      }),
    ).toBe(true);
  });

  it('ignores duration when the candidate is a stream', () => {
    expect(
      isPlausibleAlternative(original, {
        title: 'Banda Kaam Ka',
        author: 'Chaar Diwaari',
        durationMs: 0,
      }),
    ).toBe(true);
  });
});

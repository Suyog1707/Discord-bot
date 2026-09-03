import { describe, expect, it } from 'vitest';

import { isPlausibleAlternative, playbackSourceOf } from './track.js';

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

describe('playbackSourceOf', () => {
  it('reports where the audio actually came from, not what the track displays as', () => {
    // A Spotify-identified track streamed from SoundCloud. The re-source path
    // must flip to YouTube, not away from "spotify" — which names no provider.
    expect(playbackSourceOf({ source: 'spotify', playbackSource: 'soundcloud' })).toBe(
      'soundcloud',
    );
    expect(playbackSourceOf({ source: 'spotify', playbackSource: 'youtube' })).toBe('youtube');
  });

  it('falls back to the display source for a track that predates the field', () => {
    // Restored queues written before `playbackSource` existed.
    expect(playbackSourceOf({ source: 'soundcloud' })).toBe('soundcloud');
    expect(playbackSourceOf({ source: 'youtube' })).toBe('youtube');
  });

  it('decides mix-seed eligibility for the rows autoplay actually reads', () => {
    // YouTube mixes are keyed by video id. These are the three history-row
    // shapes the mix fallback filters, and only the first two carry an
    // identifier a radio URL can be built from.
    const rows = [
      { source: 'youtube' as const, playbackSource: 'youtube' as const },
      { source: 'spotify' as const, playbackSource: 'youtube' as const },
      { source: 'spotify' as const, playbackSource: 'soundcloud' as const },
    ];
    expect(rows.map((row) => playbackSourceOf(row) === 'youtube')).toEqual([true, true, false]);
  });

  it('reads a metadata-only source as YouTube', () => {
    // Spotify and Deezer cannot stream anything, so a track recorded against
    // one of them came from the old single-provider pipeline.
    expect(playbackSourceOf({ source: 'spotify' })).toBe('youtube');
    expect(playbackSourceOf({ source: 'deezer' })).toBe('youtube');
  });
});

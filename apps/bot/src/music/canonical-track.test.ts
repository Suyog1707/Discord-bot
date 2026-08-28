import { describe, expect, it } from 'vitest';

import {
  canonicalKey,
  canonicalTrack,
  describeCanonical,
  joinedArtists,
  normaliseIsrc,
  splitArtists,
} from './canonical-track.js';

describe('normaliseIsrc', () => {
  it('strips cosmetic punctuation and uppercases', () => {
    expect(normaliseIsrc('us-um7-19-00028')).toBe('USUM71900028');
  });

  it('rejects anything that is not shaped like an ISRC', () => {
    // A provider putting something else in the ISRC field is worse than an
    // absent one: it would be treated as decisive evidence.
    expect(normaliseIsrc('not-an-isrc')).toBeNull();
    expect(normaliseIsrc('USUM7190002')).toBeNull();
    expect(normaliseIsrc(null)).toBeNull();
    expect(normaliseIsrc(undefined)).toBeNull();
  });
});

describe('splitArtists', () => {
  it('separates every credited name', () => {
    expect(splitArtists('Metro Boomin, The Weeknd & 21 Savage')).toEqual([
      'Metro Boomin',
      'The Weeknd',
      '21 Savage',
    ]);
  });

  it('drops feature markers', () => {
    expect(splitArtists('Dua Lipa feat. DaBaby')).toEqual(['Dua Lipa', 'DaBaby']);
  });
});

describe('canonicalTrack', () => {
  it('derives the artist list and lead credit from a joined string', () => {
    const track = canonicalTrack({
      title: '  Creepin  ',
      artist: 'Metro Boomin, The Weeknd',
      provider: 'spotify',
    });
    expect(track.title).toBe('Creepin');
    expect(track.primaryArtist).toBe('Metro Boomin');
    expect(track.artists).toEqual(['Metro Boomin', 'The Weeknd']);
    expect(joinedArtists(track)).toBe('Metro Boomin, The Weeknd');
  });

  it('prefers an explicit artist list over splitting', () => {
    const track = canonicalTrack({
      title: 'Creepin',
      artist: 'Metro Boomin',
      artists: ['Metro Boomin', 'The Weeknd', '21 Savage'],
      provider: 'deezer',
    });
    expect(track.artists).toHaveLength(3);
  });

  it('never reports a negative or fractional duration', () => {
    const track = canonicalTrack({
      title: 'x',
      artist: 'y',
      durationMs: -5,
      provider: 'query',
    });
    expect(track.durationMs).toBe(0);
  });
});

describe('canonicalKey', () => {
  const base = {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    durationMs: 200_040,
    provider: 'spotify' as const,
  };

  it('keys on the ISRC alone when one is known', () => {
    const fromSpotify = canonicalTrack({ ...base, isrc: 'USUM71900028' });
    const fromDeezer = canonicalTrack({
      title: 'Blinding Lights (Remastered)',
      artist: 'Weeknd, The',
      durationMs: 199_000,
      isrc: 'usum7-1900028',
      provider: 'deezer',
    });
    // Two catalogues describing the same master must be one cache entry.
    expect(canonicalKey(fromSpotify)).toBe('isrc:USUM71900028');
    expect(canonicalKey(fromDeezer)).toBe(canonicalKey(fromSpotify));
  });

  it('separates recordings of different lengths without an ISRC', () => {
    const studio = canonicalTrack(base);
    const longer = canonicalTrack({ ...base, durationMs: 310_000 });
    expect(canonicalKey(studio)).not.toBe(canonicalKey(longer));
  });

  it('collapses cosmetic title differences without an ISRC', () => {
    const plain = canonicalTrack(base);
    const decorated = canonicalTrack({
      ...base,
      title: 'Blinding Lights (Official Video)',
      durationMs: 200_900,
    });
    expect(canonicalKey(plain)).toBe(canonicalKey(decorated));
  });
});

describe('describeCanonical', () => {
  it('reads as artist — title', () => {
    const track = canonicalTrack({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      provider: 'spotify',
    });
    expect(describeCanonical(track)).toBe('The Weeknd — Blinding Lights');
  });
});

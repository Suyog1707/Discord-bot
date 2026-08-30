import { describe, expect, it } from 'vitest';

import { GENRE_RULES, normaliseTags } from './genre-taxonomy.js';

describe('normaliseTags', () => {
  // The bug this table exists for: a listener with a deep Bollywood history got
  // no affinity credit for the next Bollywood track, because Last.fm spells the
  // same scene four different ways and each spelling was its own key.
  it('folds every Bollywood spelling into one genre and family', () => {
    const result = normaliseTags(['Bollywood', 'bollywood', 'Filmi', 'Hindi Film Songs']);

    expect(result.genres).toEqual(['bollywood']);
    expect(result.families).toEqual(['indian']);
    expect(result.styles).toEqual([]);
  });

  it('folds hip-hop spellings into one genre', () => {
    const result = normaliseTags(['Hip-Hop', 'hip hop', 'rap']);

    expect(result.genres).toEqual(['hip-hop']);
    expect(result.families).toEqual(['hip-hop']);
  });

  // A tag is allowed to be two things at once — unlike language, where the
  // first match wins. "punjabi hip hop" is both, and the scorer wants both.
  it('records every rule a tag hits', () => {
    const result = normaliseTags(['punjabi hip hop']);

    expect(result.genres).toContain('punjabi');
    expect(result.genres).toContain('hip-hop');
    expect(result.families).toEqual(['indian', 'hip-hop']);
  });

  it('orders genres specific-first', () => {
    const result = normaliseTags(['punjabi pop']);

    expect(result.genres).toEqual(['punjabi', 'pop']);
  });

  it('drops library bookkeeping, decades and bare numbers', () => {
    const result = normaliseTags([
      'seen live',
      'favorites',
      'favourite',
      '80s',
      '2010s',
      "90's",
      'all',
      'awesome',
      'love',
      '2019',
    ]);

    expect(result).toEqual({ genres: [], families: [], styles: [] });
  });

  // Language is resolved separately, with a confidence attached. Leaving the
  // tag in `styles` as well would let the same fact be counted twice.
  it('drops tags the language layer has already consumed', () => {
    const result = normaliseTags(['hindi', 'british']);

    expect(result.genres).toEqual([]);
    expect(result.styles).toEqual([]);
  });

  it('keeps tags no rule claims as styles', () => {
    const result = normaliseTags(['guitar', 'summer vibes', 'road trip']);

    expect(result.genres).toEqual([]);
    expect(result.families).toEqual([]);
    expect(result.styles).toEqual(['guitar', 'summer vibes', 'road trip']);
  });

  it('dedupes styles across spellings and casing', () => {
    expect(normaliseTags(['Summer Vibes', 'summer  vibes', 'summer vibes']).styles).toEqual([
      'summer vibes',
    ]);
  });

  // Substring matching is what made "indie" look like "indian"; every token is
  // compared as a whole word sequence for exactly this reason.
  it('matches whole words only', () => {
    expect(normaliseTags(['popular']).genres).toEqual([]);
    expect(normaliseTags(['popular']).styles).toEqual(['popular']);
    expect(normaliseTags(['indie']).genres).toEqual(['alternative']);
  });

  it('returns empty arrays for empty input', () => {
    expect(normaliseTags([])).toEqual({ genres: [], families: [], styles: [] });
    expect(normaliseTags(['', '   '])).toEqual({ genres: [], families: [], styles: [] });
  });
});

describe('GENRE_RULES', () => {
  it('is a table of well-formed rules', () => {
    expect(GENRE_RULES.length).toBeGreaterThanOrEqual(35);

    for (const rule of GENRE_RULES) {
      expect(rule.genre).toMatch(/^[a-z0-9-]+$/u);
      expect(rule.family).toMatch(/^[a-z0-9-]+$/u);
      expect(rule.tokens.length).toBeGreaterThan(0);
    }
  });

  it('gives each genre exactly one family', () => {
    const families = new Map<string, string>();
    for (const rule of GENRE_RULES) {
      const existing = families.get(rule.genre);
      if (existing !== undefined) expect(existing).toBe(rule.family);
      families.set(rule.genre, rule.family);
    }
    expect(families.size).toBe(GENRE_RULES.length);
  });
});

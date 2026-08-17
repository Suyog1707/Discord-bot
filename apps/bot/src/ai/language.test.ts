import { describe, expect, it } from 'vitest';

import { languageFromTag, languageFromTags, languageFromText } from './language.js';

describe('languageFromTag', () => {
  // The bug this file exists for: a real guild listening to Indian hip hop
  // produced no language at all, because an exact-match table never matched
  // "desi hip hop" or "indian pop".
  it('matches a language token inside a compound tag', () => {
    expect(languageFromTag('desi hip hop')).toBe('hindi');
    expect(languageFromTag('indian pop')).toBe('hindi');
    expect(languageFromTag('hindi rap')).toBe('hindi');
    expect(languageFromTag('classic bollywood')).toBe('hindi');
  });

  it('prefers the more specific language on an ambiguous compound', () => {
    // Both "punjabi" and the broader "indian" appear; Punjabi must win.
    expect(languageFromTag('punjabi indian hip hop')).toBe('punjabi');
    expect(languageFromTag('punjabi pop')).toBe('punjabi');
  });

  it('maps regional cinema tags to their language', () => {
    expect(languageFromTag('kollywood')).toBe('tamil');
    expect(languageFromTag('tollywood')).toBe('telugu');
    expect(languageFromTag('filmi')).toBe('hindi');
  });

  it('handles casing', () => {
    expect(languageFromTag('Bollywood')).toBe('hindi');
    expect(languageFromTag('K-Pop')).toBe('korean');
  });

  // False positives actively mis-rank, because the scorer treats a confidently
  // wrong language as a penalty while an unknown one is merely uninformative.
  it('returns null for tags that say nothing about language', () => {
    for (const tag of ['chill', 'indie', 'rock', '2020s', 'guitar', 'seen live', 'lofi']) {
      expect(languageFromTag(tag)).toBeNull();
    }
  });

  it('does not mistake "indie" for "indian"', () => {
    expect(languageFromTag('indie')).toBeNull();
    expect(languageFromTag('indie rock')).toBeNull();
  });
});

describe('languageFromTags', () => {
  it('returns the first language any tag implies', () => {
    expect(languageFromTags(['chill', 'guitar', 'bhangra'])).toBe('punjabi');
  });

  it('returns null when no tag implies one', () => {
    expect(languageFromTags(['chill', 'guitar'])).toBeNull();
    expect(languageFromTags([])).toBeNull();
  });

  // Nobody tags anglophone music "english"; nationality tags are how Last.fm
  // actually marks it. Without these, English candidates were unknown-language
  // and slid past the mismatch penalty in a Hindi session.
  it('reads anglophone nationality tags as English', () => {
    expect(languageFromTag('british')).toBe('english');
    expect(languageFromTag('american pop')).toBe('english');
    expect(languageFromTag('britpop')).toBe('english');
  });

  it('does not read "latin american" as English', () => {
    expect(languageFromTag('latin american')).toBe('spanish');
  });
});

describe('languageFromText', () => {
  // A Devanagari title is a Hindi song regardless of tags, and the title is
  // available before any network call — this is the free signal seed-language
  // inference tries first.
  it('reads a language off the writing system', () => {
    expect(languageFromText('तुम ही हो')).toBe('hindi');
    expect(languageFromText('ਪੰਜਾਬੀ ਗੀਤ')).toBe('punjabi');
    expect(languageFromText('사랑해')).toBe('korean');
    expect(languageFromText('夜に駆ける feat. ずっと')).toBe('japanese');
  });

  it('returns null for Latin script — transliteration says nothing', () => {
    expect(languageFromText('Tum Hi Ho')).toBeNull();
    expect(languageFromText('Shape of You')).toBeNull();
  });
});

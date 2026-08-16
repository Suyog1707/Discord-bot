import { describe, expect, it } from 'vitest';

import { languageFromTag, languageFromTags } from './language.js';

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
});

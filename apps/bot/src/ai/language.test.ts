import { describe, expect, it } from 'vitest';

import {
  languageFromCountry,
  languageFromProvider,
  languageFromTag,
  languageFromTags,
  languageFromText,
  resolveLanguage,
} from './language.js';

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

describe('resolveLanguage', () => {
  const song = { title: 'Kesariya', artist: 'Arijit Singh' };

  // A provider that publishes a language field measured it; nothing inferred
  // below should be allowed to argue with it.
  it('prefers an explicit provider language over every inference', () => {
    expect(
      resolveLanguage({ ...song, providerLanguage: 'en', tags: ['bollywood', 'hindi'] }),
    ).toEqual({ language: 'english', confidence: 'high', source: 'provider' });
  });

  it('accepts provider language codes with a region or a full name', () => {
    expect(resolveLanguage({ ...song, providerLanguage: 'hi-IN' }).language).toBe('hindi');
    expect(resolveLanguage({ ...song, providerLanguage: 'Hindi' }).language).toBe('hindi');
    expect(resolveLanguage({ ...song, providerLanguage: '  ' }).source).not.toBe('provider');
  });

  it('trusts a tag that names a language', () => {
    expect(resolveLanguage({ ...song, tags: ['chill', 'hindi'] })).toEqual({
      language: 'hindi',
      confidence: 'high',
      source: 'tags',
    });
  });

  // "british" says where the artist is from, not what they sing in. It is still
  // the best signal available for anglophone music — nobody tags "english" —
  // but it must not carry the same weight as a language tag.
  it('downgrades a nationality tag to low, which the scorer refuses to act on', () => {
    // "british" says where the artist is from, not what language a song is
    // in — and "indian" alone must never turn a Tamil catalogue Hindi.
    expect(resolveLanguage({ ...song, tags: ['british'] })).toEqual({
      language: 'english',
      confidence: 'low',
      source: 'tags',
    });
    expect(resolveLanguage({ ...song, tags: ['indian pop'] }).confidence).toBe('low');
  });

  it('lets a specific tag win over an earlier nationality tag', () => {
    expect(resolveLanguage({ ...song, tags: ['indian', 'tamil'] })).toEqual({
      language: 'tamil',
      confidence: 'high',
      source: 'tags',
    });
  });

  it('lets the title script outrank a nationality tag', () => {
    expect(
      resolveLanguage({ title: 'தமிழ் பாடல்', artist: 'Someone', tags: ['indian'] }).language,
    ).toBe('tamil');
  });

  it('falls back to the artist country only where it is unambiguous', () => {
    expect(resolveLanguage({ title: 'Ditto', artist: 'NewJeans', artistCountry: 'KR' })).toEqual({
      language: 'korean',
      confidence: 'medium',
      source: 'artist',
    });
    expect(resolveLanguage({ ...song, artistCountry: 'BR' }).language).toBe('portuguese');
  });

  // India has a couple of dozen recording languages; the US and the UK are full
  // of artists who do not record in English. Guessing from these is how Tamil
  // and Punjabi tracks got buried in a Hindi session.
  it('reads nothing into a multilingual country', () => {
    for (const country of ['IN', 'US', 'GB']) {
      expect(resolveLanguage({ ...song, artistCountry: country })).toEqual({
        language: null,
        confidence: 'none',
        source: 'none',
      });
    }
  });

  // The free signal: available before any network call.
  it('reads the writing system when nothing else speaks', () => {
    expect(resolveLanguage({ title: 'तुम ही हो', artist: 'Arijit Singh' })).toEqual({
      language: 'hindi',
      confidence: 'medium',
      source: 'script',
    });
    expect(resolveLanguage({ title: 'Ditto', artist: '뉴진스' }).language).toBe('korean');
  });

  it('returns a clean unknown rather than guessing', () => {
    expect(resolveLanguage({ title: 'Shape of You', artist: 'Ed Sheeran' })).toEqual({
      language: null,
      confidence: 'none',
      source: 'none',
    });
    expect(resolveLanguage({ title: '', artist: '', tags: [] })).toEqual({
      language: null,
      confidence: 'none',
      source: 'none',
    });
  });

  it('never throws on missing or malformed fields', () => {
    expect(() =>
      resolveLanguage({
        title: '',
        artist: '',
        providerLanguage: null,
        tags: [],
        artistCountry: null,
      }),
    ).not.toThrow();
  });
});

describe('languageFromProvider / languageFromCountry', () => {
  it('maps codes and passes names through', () => {
    expect(languageFromProvider('ko')).toBe('korean');
    expect(languageFromProvider('pt_BR')).toBe('portuguese');
    expect(languageFromProvider('Punjabi')).toBe('punjabi');
    expect(languageFromProvider(null)).toBeNull();
    expect(languageFromProvider('')).toBeNull();
  });

  it('answers only for countries with a lopsided recording language', () => {
    expect(languageFromCountry('jp')).toBe('japanese');
    expect(languageFromCountry('IN')).toBeNull();
    expect(languageFromCountry(null)).toBeNull();
  });
});

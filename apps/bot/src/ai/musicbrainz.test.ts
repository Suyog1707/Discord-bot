import { describe, expect, it } from 'vitest';

import { normaliseArtist, normaliseTrackTitle, primaryArtist } from './musicbrainz.js';

describe('normaliseArtist', () => {
  // The whole point of the affinity engine is counting per artist, so these
  // spellings collapsing to one key is what makes the count mean anything.
  it('collapses casing variants of the same artist', () => {
    const forms = ['The Weeknd', 'the weeknd', 'THE WEEKND', 'The  Weeknd'];
    const keys = new Set(forms.map(normaliseArtist));
    expect(keys.size).toBe(1);
  });

  it('strips YouTube channel suffixes', () => {
    expect(normaliseArtist('Karan Aujla - Topic')).toBe(normaliseArtist('Karan Aujla'));
    expect(normaliseArtist('ArijitSinghVEVO')).toBe(normaliseArtist('ArijitSingh'));
    expect(normaliseArtist('T-Series Official')).toBe(normaliseArtist('T-Series'));
  });

  it('strips featured credits so the lead artist keys the count', () => {
    expect(normaliseArtist('Diljit Dosanjh feat. Sia')).toBe(normaliseArtist('Diljit Dosanjh'));
    expect(normaliseArtist('Badshah (ft. Aastha Gill)')).toBe(normaliseArtist('Badshah'));
  });

  it('folds accents so transliterated spellings match', () => {
    expect(normaliseArtist('Beyoncé')).toBe(normaliseArtist('Beyonce'));
  });

  it('drops a leading article', () => {
    expect(normaliseArtist('The Beatles')).toBe('beatles');
  });

  it('keeps genuinely different artists apart', () => {
    expect(normaliseArtist('Karan Aujla')).not.toBe(normaliseArtist('Karan Randhawa'));
  });
});

describe('primaryArtist', () => {
  // Without this, "A, B" and "A x B" each look like a fresh artist and slip past
  // the per-artist diversity cap.
  it('takes the lead of a multi-artist credit', () => {
    expect(primaryArtist('Karan Aujla, Ikky')).toBe('Karan Aujla');
    expect(primaryArtist('Karan Aujla x Ikky')).toBe('Karan Aujla');
    expect(primaryArtist('Calvin Harris & Dua Lipa')).toBe('Calvin Harris');
  });

  it('leaves a single artist untouched', () => {
    expect(primaryArtist('Arijit Singh')).toBe('Arijit Singh');
  });

  it('does not split a name that merely contains a separator word', () => {
    // "and" inside a band name must survive; only a spaced separator splits.
    expect(primaryArtist('Florence + the Machine')).toBe('Florence + the Machine');
  });
});

describe('normaliseTrackTitle', () => {
  it('strips upload decorations', () => {
    expect(normaliseTrackTitle('Softly (Official Video)')).toBe('softly');
    expect(normaliseTrackTitle('Chaand [Official Audio] ')).toBe('chaand');
    expect(normaliseTrackTitle('Blinding Lights (Official Music Video) 4K')).toContain(
      'blinding lights',
    );
  });

  it('keeps a remix marker, which is a different recording', () => {
    // Variant detection lives downstream; the title must still carry the word.
    expect(normaliseTrackTitle('Iss Tarah (Revoic Remix)')).toContain('remix');
  });
});

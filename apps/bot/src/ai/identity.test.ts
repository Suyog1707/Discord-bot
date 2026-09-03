import { describe, expect, it } from 'vitest';

import { identifierKeyOf, identityOf, trackKeyOf } from './identity.js';

describe('identityOf', () => {
  // The bug this file exists for: the exact same song shows up as a plain
  // Last.fm title, a decorated YouTube result, and a bracket-tagged lyric
  // video, and autoplay needs all three to resolve to one key or it repeats
  // the song under whichever spelling it hasn't seen yet.
  it('collapses the same song across source vocabularies', () => {
    const plain = identityOf('The Weeknd', 'Blinding Lights');
    const youtubeTopic = identityOf(
      'The Weeknd - Topic',
      'The Weeknd - Blinding Lights (Official Video)',
    );
    const lowerCasedLyrics = identityOf('the weeknd', 'Blinding Lights [Lyrics]');

    expect(youtubeTopic.key).toBe(plain.key);
    expect(lowerCasedLyrics.key).toBe(plain.key);
  });

  // A remaster is an audio touch-up, not a different recording — it must not
  // fragment the exclusion set, whether the tag is bracketed with a year or a
  // trailing " - <year> Remaster" suffix.
  it('collapses remaster tags, bracketed or as a dash suffix, with or without a year', () => {
    const plain = identityOf('The Weeknd', 'Blinding Lights');
    const bracketedYear = identityOf('The Weeknd', 'Blinding Lights (Remastered 2020)');
    const dashSuffix = identityOf('The Weeknd', 'Blinding Lights - 2011 Remaster');

    expect(bracketedYear.key).toBe(plain.key);
    expect(dashSuffix.key).toBe(plain.key);
  });

  // A featured artist is a collaboration credit, not a different song.
  it('collapses feature credits', () => {
    const plain = identityOf('Dua Lipa', 'Levitating');
    const withFeature = identityOf('Dua Lipa', 'Levitating (feat. DaBaby)');
    const bareFeature = identityOf('Dua Lipa', 'Levitating feat. DaBaby');

    expect(withFeature.key).toBe(plain.key);
    expect(bareFeature.key).toBe(plain.key);
  });

  describe('variants', () => {
    // The one rule that must never break: a remix is a different key from the
    // original, or autoplay will play it as if it had never played the song.
    it('keeps a remix distinct from the original', () => {
      const original = identityOf('Adele', 'Someone Like You');
      const remix = identityOf('Adele', 'Someone Like You (Club Remix)');

      expect(remix.key).not.toBe(original.key);
      expect(remix.variant).toBe('remix');
      expect(original.variant).toBeNull();
    });

    it('keeps a live version distinct from the original', () => {
      const original = identityOf('Adele', 'Someone Like You');
      const live = identityOf('Adele', 'Someone Like You (Live)');

      expect(live.key).not.toBe(original.key);
      expect(live.variant).toBe('live');
    });

    // Two different remixers of the same song are still repetition for
    // anti-repeat purposes, so both collapse to the single marker "remix"
    // rather than keying off the remixer's name.
    it('merges different remixes of the same song onto one variant key', () => {
      const metroRemix = identityOf('Adele', 'Someone Like You (Metro Boomin Remix)');
      const clubRemix = identityOf('Adele', 'Someone Like You (Club Remix)');

      expect(metroRemix.key).toBe(clubRemix.key);
      expect(metroRemix.variant).toBe('remix');
    });

    // Multiple variant words in one phrase all get captured, sorted so the
    // key is deterministic regardless of the order they appeared in the title.
    it('collects multiple variant markers, sorted and joined with +', () => {
      const identity = identityOf('Adele', 'Someone Like You (Live Acoustic Version)');

      expect(identity.variant).toBe('acoustic+live');
    });

    // Bare variant words (no brackets, no dash) must still be caught — a lot
    // of "Title Acoustic" uploads have no decoration at all.
    it('detects a variant word with no surrounding brackets', () => {
      const identity = identityOf('Lewis Capaldi', 'Someone You Loved Acoustic');

      expect(identity.variant).toBe('acoustic');
    });

    // The trap this whole module has to avoid: short variant words are
    // common substrings of unrelated words, and matching loosely would
    // silently misclassify real, unrelated songs.
    it('does not fire on a variant word that is a substring of a different word', () => {
      // "edit" must not fire inside "edition" or "meditation".
      const edition = identityOf('Edith Piaf', 'La Vie en Rose (Special Edition)');
      const meditation = identityOf('Some Artist', 'Meditation Music for Sleep');
      // "live" must not fire inside "alive".
      const alive = identityOf('Some Artist', 'Stay Alive');

      expect(edition.variant).toBeNull();
      expect(meditation.variant).toBeNull();
      expect(alive.variant).toBeNull();
    });

    // "radio edit" is deliberately caught by the bare word "edit" — it is the
    // same kind of touch-up as a remaster, not a new song — while still
    // refusing to fire on "edition".
    it('treats "radio edit" as the edit variant', () => {
      const identity = identityOf('Taylor Swift', 'Style (Radio Edit)');

      expect(identity.variant).toBe('edit');
    });
  });

  describe('artist-prefix stripping', () => {
    // YouTube and Last.fm both like to repeat the artist inside the title
    // itself; that repetition must not become part of the title key.
    it('strips a leading "Artist - Title" repeat of the supplied artist', () => {
      const withPrefix = identityOf('Karan Aujla', 'Karan Aujla - Softly');
      const withoutPrefix = identityOf('Karan Aujla', 'Softly');

      expect(withPrefix.key).toBe(withoutPrefix.key);
    });

    // A leading chunk that happens to share a separator but is NOT the
    // artist (e.g. an actual song called "Style - Radio Edit") must be left
    // for the noise/variant rules to handle, not eaten as a false artist match.
    it('leaves a leading chunk alone when it does not match the artist', () => {
      const identity = identityOf('Taylor Swift', 'Style - Radio Edit');

      expect(identity.titleKey).toBe('style');
      expect(identity.variant).toBe('edit');
    });
  });

  describe('multi-artist credits', () => {
    // "Karan Aujla, Ikky" and "Karan Aujla x Ikky" are the same collaboration
    // spelled two ways; the diversity/affinity logic that keys off artistKey
    // must see one artist, not two.
    it('resolves the same artistKey for comma- and x-separated credits', () => {
      const comma = identityOf('Karan Aujla, Ikky', 'Softly');
      const cross = identityOf('Karan Aujla x Ikky', 'Softly');

      expect(comma.artistKey).toBe(cross.artistKey);
    });
  });

  describe('empty and garbage titles', () => {
    // If a title is nothing but noise decoration, canonicalisation can strip
    // it down to nothing — the empty-title guard falls back to the flattened
    // raw title so the key is still usable (and still comparable) rather than
    // an empty string that would collide across unrelated songs.
    it('never produces an empty titleKey', () => {
      const pureNoise = identityOf('Some Artist', '(Official Video) (HD)');
      const pureVariant = identityOf('Some Artist', '(Remix)');
      const empty = identityOf('Some Artist', '');
      const punctuationOnly = identityOf('Some Artist', '!!!');

      for (const identity of [pureNoise, pureVariant, empty, punctuationOnly]) {
        expect(identity.titleKey.length).toBeGreaterThan(0);
        expect(identity.key).not.toMatch(/::$/u);
      }
    });
  });
});

describe('trackKeyOf', () => {
  it('returns the same value as identityOf(...).key', () => {
    expect(trackKeyOf('The Weeknd', 'Blinding Lights')).toBe(
      identityOf('The Weeknd', 'Blinding Lights').key,
    );
  });
});

describe('identifierKeyOf', () => {
  it('joins source and identifier with a colon', () => {
    expect(identifierKeyOf('youtube', 'abc')).toBe('youtube:abc');
  });

  // Sources come from different providers with inconsistent casing
  // ("YouTube", "Spotify", "lastfm"); the key has to be stable regardless.
  it('is stable and lowercased on the source, regardless of input casing', () => {
    expect(identifierKeyOf('YouTube', 'dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
    expect(identifierKeyOf('YOUTUBE', 'dQw4w9WgXcQ')).toBe(
      identifierKeyOf('youtube', 'dQw4w9WgXcQ'),
    );
  });

  // Identifiers are opaque provider IDs and are often case-sensitive
  // (YouTube video IDs in particular), so only the source is normalised.
  it('preserves identifier casing', () => {
    expect(identifierKeyOf('youtube', 'dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
  });
});

// Regressions found by the final adversarial review, pinned here.
describe('review regressions', () => {
  // "TheWeekndVEVO" loses its VEVO suffix as "TheWeeknd", which never matched
  // "The Weeknd" — every "The X" VEVO channel escaped the canonical key. The
  // camelCase split in normaliseArtist is what bridges them.
  it('matches concatenated VEVO channels to the plain artist name', () => {
    expect(identityOf('TheWeekndVEVO', 'The Weeknd - Blinding Lights (Official Video)').key).toBe(
      identityOf('The Weeknd', 'Blinding Lights').key,
    );
    // The split must be applied uniformly, or it would break the pairs that
    // already worked: "OneRepublic" from Last.fm vs "OneRepublicVEVO".
    expect(identityOf('OneRepublicVEVO', 'Counting Stars').artistKey).toBe(
      identityOf('OneRepublic', 'Counting Stars').artistKey,
    );
  });

  // Last.fm/Spotify spell 2020s collaborations "(with X)"; without this rule
  // both spellings of one song entered the pool and were queued twice.
  it('treats a "(with …)" credit as the same song', () => {
    expect(trackKeyOf('Metro Boomin', "Creepin' (with The Weeknd, 21 Savage)")).toBe(
      trackKeyOf('Metro Boomin', "Creepin'"),
    );
  });

  // Indic vowel signs are combining marks; stripping them deleted every vowel,
  // so सोच (soch) and सच (sach) — different words — collapsed into one key and
  // each permanently excluded the other from autoplay.
  it('keeps Devanagari and Gurmukhi vowels', () => {
    expect(trackKeyOf('Arijit Singh', 'सोच')).not.toBe(trackKeyOf('Arijit Singh', 'सच'));
    expect(trackKeyOf('Diljit Dosanjh', 'ਸੋਹਣੀ')).not.toBe(trackKeyOf('Diljit Dosanjh', 'ਸਹਿਣੀ'));
  });

  it('still folds Latin accents', () => {
    expect(trackKeyOf('Beyoncé', 'Déjà Vu')).toBe(trackKeyOf('Beyonce', 'Deja Vu'));
  });
});

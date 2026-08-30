import { describe, expect, it } from 'vitest';

import {
  identifierKeyOf,
  identityOf,
  normaliseArtist,
  normaliseIsrc,
  trackKeyOf,
} from './index.js';

/**
 * The bot keeps the exhaustive suites (ai/identity.test.ts,
 * ai/musicbrainz.test.ts, music/canonical-track.test.ts). These five guard the
 * claim that makes the module worth sharing: the dashboard and the bot compute
 * the same key from the same song, however it was spelled.
 */
describe('music-identity', () => {
  it('collapses the same song across source vocabularies', () => {
    const plain = identityOf('The Weeknd', 'Blinding Lights');

    expect(
      identityOf('The Weeknd - Topic', 'The Weeknd - Blinding Lights (Official Video)').key,
    ).toBe(plain.key);
    expect(identityOf('the weeknd', 'Blinding Lights [Lyrics]').key).toBe(plain.key);
  });

  it('keeps a remix distinct from the original', () => {
    const original = trackKeyOf('The Weeknd', 'Blinding Lights');
    const remix = identityOf('The Weeknd', 'Blinding Lights (Metro Boomin Remix)');

    expect(remix.key).not.toBe(original);
    expect(remix.variant).toBe('remix');
  });

  it('keys collaborations on the lead artist', () => {
    expect(normaliseArtist('Karan Aujla, Ikky')).toBe(normaliseArtist('Karan Aujla, Ikky'));
    expect(identityOf('Karan Aujla x Ikky', 'Softly').artistKey).toBe(
      identityOf('Karan Aujla', 'Softly').artistKey,
    );
  });

  it('normalises a well-formed ISRC and rejects anything else', () => {
    expect(normaliseIsrc('usug1-190-1216')).toBe('USUG11901216');
    expect(normaliseIsrc('not-an-isrc')).toBeNull();
    expect(normaliseIsrc(null)).toBeNull();
  });

  it('lowercases only the source of an identifier key', () => {
    expect(identifierKeyOf(' YouTube ', ' dQw4w9WgXcQ ')).toBe('youtube:dQw4w9WgXcQ');
  });
});

import { describe, expect, it } from 'vitest';

import { toAutocompleteChoices, type SpotifySearchHit } from './search.js';

function hit(overrides: Partial<SpotifySearchHit> = {}): SpotifySearchHit {
  return {
    kind: 'track',
    name: 'Parwana',
    artist: 'Arijit Singh',
    url: 'https://open.spotify.com/track/abc',
    ...overrides,
  };
}

describe('toAutocompleteChoices', () => {
  it('shows what will play, and plays what it shows', () => {
    // The value is the Spotify URL, not a provider link. When these were
    // YouTube results every tapped suggestion quietly bypassed the
    // Spotify-first pipeline.
    const [choice] = toAutocompleteChoices([hit()]);

    expect(choice?.value).toBe('https://open.spotify.com/track/abc');
    expect(choice?.name).toBe('🎵 Parwana — Arijit Singh');
  });

  it('drops artists, which do not say what would play', () => {
    const choices = toAutocompleteChoices([
      hit({ kind: 'artist', name: 'Arijit Singh', artist: null }),
      hit({ kind: 'album', name: 'Parwana', url: 'https://open.spotify.com/album/x' }),
    ]);

    expect(choices).toHaveLength(1);
    expect(choices[0]?.name).toBe('💿 Parwana — Arijit Singh');
  });

  it('omits an artist that is not there rather than a dangling dash', () => {
    expect(toAutocompleteChoices([hit({ artist: null })])[0]?.name).toBe('🎵 Parwana');
  });

  it('clips a name Discord would reject', () => {
    const long = toAutocompleteChoices([hit({ name: 'x'.repeat(200) })])[0];

    expect(long?.name.length).toBeLessThanOrEqual(100);
    expect(long?.name.endsWith('…')).toBe(true);
  });

  it('drops a URL too long to be a choice value', () => {
    // Discord caps the value at 100 characters too, and an over-long one is
    // rejected for the whole response rather than for that row.
    expect(
      toAutocompleteChoices([hit({ url: `https://open.spotify.com/${'x'.repeat(100)}` })]),
    ).toHaveLength(0);
  });

  it('never offers more than Discord will show', () => {
    const many = Array.from({ length: 25 }, (_unused, index) =>
      hit({
        name: `Track ${String(index)}`,
        url: `https://open.spotify.com/track/${String(index)}`,
      }),
    );

    expect(toAutocompleteChoices(many)).toHaveLength(10);
  });
});

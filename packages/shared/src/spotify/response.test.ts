import { describe, expect, it } from 'vitest';
import { spotifyApiUrl, spotifyPlaylistCount, spotifyTrack } from './response.js';
describe('Spotify response normalization', () => {
  it('accepts current and legacy counts', () => {
    expect(spotifyPlaylistCount({ items: { total: 42 } })).toBe(42);
    expect(spotifyPlaylistCount({ tracks: { total: 12 } })).toBe(12);
    expect(spotifyPlaylistCount({})).toBe(0);
  });
  it('keeps unavailable items null and accepts legacy entries', () => {
    expect(spotifyTrack({ item: null, track: 'legacy' })).toBeNull();
    expect(spotifyTrack({ track: 'legacy' })).toBe('legacy');
    expect(spotifyTrack(null)).toBeNull();
  });
  it('rejects bearer-token exfiltration through pagination URLs', () => {
    expect(() => spotifyApiUrl('https://attacker.example/next')).toThrow();
    expect(() => spotifyApiUrl('//attacker.example/next')).toThrow();
    expect(spotifyApiUrl('/v1/me/playlists')).toBe('https://api.spotify.com/v1/me/playlists');
  });
});

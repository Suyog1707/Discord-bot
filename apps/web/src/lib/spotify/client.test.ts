import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXTAUTH_URL: 'https://music.example.com',
    NODE_ENV: 'production',
    SPOTIFY_CLIENT_ID: 'id',
    SPOTIFY_CLIENT_SECRET: 'secret',
    SPOTIFY_REDIRECT_URI: 'https://music.example.com/api/spotify/callback',
  }),
}));
import { authorizeUrl, getPlaylistTracks, getSavedTracks, listPlaylists } from './client';

const track = { id: 'song', name: 'Song', duration_ms: 200_000, artists: [{ name: 'Artist' }] };
function responses(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies) fetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe('dashboard Spotify client', () => {
  it.each([
    [401, 'Reconnect Spotify'],
    [403, 'own or collaborate'],
    [404, 'private, or deleted'],
    [429, 'Retry in 120 seconds'],
  ])('explains HTTP %s without leaking the upstream body', async (status, message) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('private-token-secret', { status, headers: { 'Retry-After': '120' } }),
        ),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(getPlaylistTracks('private-token', 'playlist', 20)).rejects.toThrow(message);
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-token-secret');
    } finally {
      log.mockRestore();
    }
  });
  it('uses the public callback and includes CSRF state', () => {
    const url = new URL(authorizeUrl('random-state'));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://music.example.com/api/spotify/callback',
    );
    expect(url.searchParams.get('state')).toBe('random-state');
  });
  it('uses the current endpoint and skips unavailable, local and episode items', async () => {
    const fetch = responses({
      items: [
        null,
        { item: null },
        { item: { ...track, is_local: true } },
        { item: { id: 'episode', name: 'Podcast' } },
        { item: track },
        { track },
      ],
      next: null,
    });
    expect(await getPlaylistTracks('private-token', 'playlist', 20)).toHaveLength(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.spotify.com/v1/playlists/playlist/items?limit=50',
    );
  });
  it('follows pagination and respects the track limit', async () => {
    responses(
      { items: [{ item: track }], next: 'https://api.spotify.com/v1/next' },
      { items: [{ item: track }, { item: track }], next: null },
    );
    expect(await getPlaylistTracks('token', 'playlist', 2)).toHaveLength(2);
  });
  it('never sends bearer credentials to an external pagination host', async () => {
    const fetch = responses({ items: [], next: 'https://attacker.example/steal' });
    await expect(getPlaylistTracks('token', 'playlist', 2)).rejects.toThrow(
      'Invalid Spotify pagination origin',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('filters null playlists and tolerates unavailable saved tracks', async () => {
    responses({ items: [null, { id: 'p', name: 'Playlist', items: { total: 42 } }], next: null });
    expect(await listPlaylists('token')).toHaveLength(1);
    responses({ items: [null, { track: null }, { track }], next: null });
    expect(await getSavedTracks('token', 20)).toHaveLength(1);
  });
  it('does not fetch anything for a zero queue capacity', async () => {
    const fetch = responses();
    expect(await getPlaylistTracks('token', 'playlist', 0)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses missing contents with an actionable error', async () => {
    responses({ next: null });
    await expect(getPlaylistTracks('token', 'playlist', 20)).rejects.toThrow('own or collaborate');
  });
  it('stops malformed repeated pagination rather than looping forever', async () => {
    const next = 'https://api.spotify.com/v1/repeated';
    responses({ items: [], next }, { items: [], next });
    await expect(getPlaylistTracks('token', 'playlist', 20)).rejects.toThrow(
      'repeated track pages',
    );
  });
});

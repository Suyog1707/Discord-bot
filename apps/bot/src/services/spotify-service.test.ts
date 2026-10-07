/**
 * The corrected Spotify request shapes.
 *
 * Cover current Spotify playlist responses and legacy compatibility.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-secret';

vi.mock('../config/env.js', () => ({
  getEnv: () => ({
    NEXTAUTH_SECRET: SECRET,
    SPOTIFY_CLIENT_ID: 'client-id',
    SPOTIFY_CLIENT_SECRET: 'client-secret',
  }),
}));

const { SpotifyService } = await import('./spotify-service.js');

/** Mirror of the service's own v1 format, so a row looks like the dashboard wrote it. */
function encrypt(plaintext: string): string {
  const key = createHash('sha256').update(`${SECRET}:token-encryption`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    data.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

const account = {
  id: 'acc-1',
  accessToken: encrypt('access-token'),
  refreshToken: encrypt('refresh-token'),
  // Far future, so no refresh round trip runs during these tests.
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makePrisma(): unknown {
  return { spotifyAccount: { findFirst: vi.fn(() => Promise.resolve(account)) } };
}

function makeService(): InstanceType<typeof SpotifyService> {
  return new SpotifyService(makePrisma() as never);
}

/** Queue one JSON body per expected request, in order. */
function mockFetchSequence(bodies: readonly unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    void url;
    const body = bodies[fetchMock.mock.calls.length - 1] ?? {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const rawTrack = {
  id: 't1',
  name: 'Kesariya',
  duration_ms: 240_000,
  artists: [{ name: 'Arijit Singh' }],
  album: { name: 'Brahmastra', images: [{ url: 'https://img/1.png' }] },
  external_urls: { spotify: 'https://open.spotify.com/track/t1' },
};

describe('playlistTracks', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the current /items route for a playlist', async () => {
    const fetchMock = mockFetchSequence([{ items: [], next: null }]);

    await makeService().playlistTracks('123', 'playlist-abc', 50);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.spotify.com/v1/playlists/playlist-abc/items?limit=50',
    );
  });

  it('reads Liked Songs from /me/tracks', async () => {
    const fetchMock = mockFetchSequence([{ items: [], next: null }]);

    await makeService().playlistTracks('123', 'liked-songs', 50);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.spotify.com/v1/me/tracks?limit=50');
  });

  it('unwraps the current item field', async () => {
    mockFetchSequence([{ items: [{ item: rawTrack }], next: null }]);
    expect(await makeService().playlistTracks('123', 'p', 50)).toHaveLength(1);
  });

  it('unwraps each entry from the track field', async () => {
    mockFetchSequence([{ items: [{ track: rawTrack }], next: null }]);

    const tracks = await makeService().playlistTracks('123', 'playlist-abc', 50);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      title: 'Kesariya',
      artist: 'Arijit Singh',
      durationMs: 240_000,
      spotifyId: 't1',
    });
  });

  it('joins every credited artist', async () => {
    mockFetchSequence([
      {
        items: [
          { track: { ...rawTrack, artists: [{ name: 'Arijit Singh' }, { name: 'Shreya' }] } },
        ],
        next: null,
      },
    ]);

    const tracks = await makeService().playlistTracks('123', 'p', 50);

    expect(tracks[0]?.artist).toBe('Arijit Singh, Shreya');
  });

  /** Removed, region-locked and local-file rows all have to be survivable. */
  it('skips null entries, null tracks and local files', async () => {
    mockFetchSequence([
      {
        items: [
          null,
          { track: null },
          { track: { ...rawTrack, is_local: true } },
          { track: rawTrack },
        ],
        next: null,
      },
    ]);

    const tracks = await makeService().playlistTracks('123', 'p', 50);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBe('Kesariya');
  });

  it('follows next and stops at the requested limit', async () => {
    const page = (next: string | null): unknown => ({
      items: [{ track: rawTrack }, { track: { ...rawTrack, id: 't2', name: 'Second' } }],
      next,
    });
    mockFetchSequence([page('https://api.spotify.com/v1/next-page'), page(null)]);

    const tracks = await makeService().playlistTracks('123', 'p', 3);

    expect(tracks).toHaveLength(3);
  });
  it('refuses repeated pages instead of looping forever', async () => {
    const next = 'https://api.spotify.com/v1/repeat';
    mockFetchSequence([
      { items: [], next },
      { items: [], next },
    ]);
    await expect(makeService().playlistTracks('123', 'p', 3)).rejects.toThrow(
      'repeated track pages',
    );
  });
  it('explains a missing playlist contents response', async () => {
    mockFetchSequence([{ next: null }]);
    await expect(makeService().playlistTracks('123', 'p', 3)).rejects.toThrow('own or collaborate');
  });
});

describe('listPlaylists', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  /** The count bug: the API field is `tracks.total`, not `items.total`. */
  it('reads the track count from tracks.total', async () => {
    mockFetchSequence([
      {
        items: [
          {
            id: 'p1',
            name: 'Road trip',
            snapshot_id: 'snap-1',
            tracks: { total: 42 },
            owner: { display_name: 'Suyog' },
            images: [{ url: 'https://img/p1.png' }],
            public: true,
          },
        ],
        next: null,
      },
    ]);

    const playlists = await makeService().listPlaylists('123');

    // Liked Songs is always prepended.
    expect(playlists[0]?.spotifyId).toBe('liked-songs');
    expect(playlists[1]).toMatchObject({
      spotifyId: 'p1',
      name: 'Road trip',
      trackCount: 42,
      owner: 'Suyog',
      snapshotId: 'snap-1',
    });
  });
  it('reads the 2026 items count', async () => {
    mockFetchSequence([
      { items: [{ id: 'p', name: 'Current', items: { total: 42 }, owner: null }], next: null },
    ]);
    expect((await makeService().listPlaylists('123'))[1]?.trackCount).toBe(42);
  });

  /** Spotify pads pages with nulls for playlists the user can no longer see. */
  it('survives null entries and missing tracks/owner objects', async () => {
    mockFetchSequence([
      {
        items: [
          null,
          {
            id: 'p2',
            name: 'Orphaned',
            snapshot_id: 's',
            tracks: null,
            owner: null,
            public: null,
          },
        ],
        next: null,
      },
    ]);

    const playlists = await makeService().listPlaylists('123');

    expect(playlists).toHaveLength(2);
    expect(playlists[1]).toMatchObject({ spotifyId: 'p2', trackCount: 0, owner: null });
  });
});

describe('Spotify link cache invalidation', () => {
  it('does not keep a deleted dashboard link alive through a cached token', async () => {
    const findFirst = vi.fn(() => Promise.resolve(account as typeof account | null));
    const service = new SpotifyService({ spotifyAccount: { findFirst } } as never);
    expect(await service.accessTokenForPlayback('123')).toBe('access-token');
    findFirst.mockResolvedValueOnce(null);
    expect(await service.accessTokenForPlayback('123')).toBeNull();
  });
  it('uses a newly linked account token rather than the previous cached token', async () => {
    const findFirst = vi.fn(() => Promise.resolve(account));
    const service = new SpotifyService({ spotifyAccount: { findFirst } } as never);
    await service.accessTokenForPlayback('123');
    findFirst.mockResolvedValueOnce({ ...account, accessToken: encrypt('new-access') });
    expect(await service.accessTokenForPlayback('123')).toBe('new-access');
  });
});

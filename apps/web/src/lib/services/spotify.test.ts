import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPlaylists = vi.fn<(token: string) => Promise<unknown>>();
const findUnique = vi.fn();
vi.mock('@/lib/spotify/client', () => ({
  listPlaylists: (t: string): Promise<unknown> => listPlaylists(t),
}));
vi.mock('@/lib/crypto', () => ({ decryptToken: (v: string) => v, encryptToken: (v: string) => v }));
vi.mock('@/lib/logger', () => ({ getLogger: () => ({ child: () => ({ info: vi.fn() }) }) }));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    spotifyAccount: { findUnique },
    playlist: { findMany: () => Promise.resolve([]) },
  }),
}));

import { listImportable } from './spotify';

const summary = (id: string, owner: string | undefined, collaborative?: boolean) => ({
  id,
  name: id,
  snapshot_id: 's',
  tracks: { total: 3 },
  owner: owner === undefined ? null : { id: owner, display_name: owner },
  public: false,
  ...(collaborative === undefined ? {} : { collaborative }),
});

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    id: 'a',
    spotifyId: 'me',
    displayName: 'Me',
    country: null,
    scopes: 'x',
    createdAt: new Date(),
    autoplayOptIn: false,
    accessToken: 'tok',
    refreshToken: 'ref',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
});

describe('listImportable ownership flag', () => {
  it('blocks only playlists someone else owns and nobody shares with you', async () => {
    listPlaylists.mockResolvedValue([
      summary('owned', 'me'),
      summary('collab', 'friend', true),
      summary('foreign', 'friend', false),
      summary('foreign-unflagged', 'friend'),
    ]);
    const items = await listImportable('user');
    const blocked = Object.fromEntries(items.map((i) => [i.spotifyId, i.importBlocked]));
    expect(blocked).toEqual({
      'liked-songs': false,
      owned: false,
      collab: false,
      foreign: true,
      'foreign-unflagged': true,
    });
  });

  it('does not warn when the owner is unknown', async () => {
    listPlaylists.mockResolvedValue([summary('mystery', undefined)]);
    const items = await listImportable('user');
    expect(items.find((i) => i.spotifyId === 'mystery')?.importBlocked).toBe(false);
  });
});

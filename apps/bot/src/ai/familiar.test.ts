import { MusicSource as DbMusicSource } from '@discord-music/database';
import type { PrismaClient } from '@discord-music/database';
import { describe, expect, it, vi } from 'vitest';

import { CacheService } from './cache.js';
import { FamiliarPoolService } from './familiar.js';

/**
 * The rows the service selects, as plain objects.
 *
 * Prisma is stubbed rather than run: every assertion here is about the merge
 * rules, and those are pure once the rows are in hand.
 */
interface FavoriteRow {
  identifier: string;
  title: string;
  author: string;
  durationMs: number;
  uri: string | null;
  source: DbMusicSource;
  artworkUrl: string | null;
  user: { discordId: string } | null;
}

interface TrackRow {
  identifier: string;
  title: string;
  author: string;
  durationMs: number;
  uri: string | null;
  source: DbMusicSource;
  artworkUrl: string | null;
}

interface PlaylistRow {
  favorite: boolean;
  playCount: number;
  owner: { discordId: string } | null;
  tracks: TrackRow[];
}

interface HistoryRow {
  identifier: string;
  title: string;
  author: string;
  durationMs: number;
  uri: string | null;
  source: DbMusicSource;
  playedMs: number;
  skipped: boolean;
  origin: string;
  playedAt: Date;
  userId: string | null;
}

function favorite(overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  return {
    identifier: 'fav-1',
    title: 'Blinding Lights',
    author: 'The Weeknd',
    durationMs: 200_000,
    uri: 'https://open.spotify.com/track/blinding',
    source: DbMusicSource.SPOTIFY,
    artworkUrl: 'https://art.test/blinding.jpg',
    user: { discordId: 'u1' },
    ...overrides,
  };
}

function playlistTrack(overrides: Partial<TrackRow> = {}): TrackRow {
  return {
    identifier: 'pl-1',
    title: 'Blinding Lights (Official Video)',
    author: 'The Weeknd',
    durationMs: 201_000,
    uri: 'https://youtube.test/blinding',
    source: DbMusicSource.YOUTUBE,
    artworkUrl: null,
    ...overrides,
  };
}

function playlist(overrides: Partial<PlaylistRow> = {}): PlaylistRow {
  return {
    favorite: false,
    playCount: 0,
    owner: { discordId: 'u1' },
    tracks: [playlistTrack()],
    ...overrides,
  };
}

function history(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    identifier: 'yt-1',
    title: 'Blinding Lights (Remastered 2020)',
    author: 'The Weeknd',
    durationMs: 200_000,
    uri: 'https://youtube.test/blinding',
    source: DbMusicSource.YOUTUBE,
    playedMs: 200_000,
    skipped: false,
    origin: 'user',
    playedAt: new Date('2026-08-01T00:00:00Z'),
    userId: 'user-row-1',
    ...overrides,
  };
}

function fakePrisma(data: {
  favorites?: FavoriteRow[] | Error;
  playlists?: PlaylistRow[] | Error;
  history?: HistoryRow[] | Error;
}) {
  // The argument is typed `unknown` rather than dropped so the tests that
  // assert on the generated `where` clause can read it back.
  const answer = <T>(value: T[] | Error | undefined) =>
    vi.fn((_args: unknown): Promise<T[]> =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []),
    );

  const stub = {
    favoriteTrack: { findMany: answer<FavoriteRow>(data.favorites) },
    playlist: { findMany: answer<PlaylistRow>(data.playlists) },
    songHistory: { findMany: answer<HistoryRow>(data.history) },
  };

  return { stub, prisma: stub as unknown as PrismaClient };
}

function serviceWith(data: Parameters<typeof fakePrisma>[0]) {
  const { stub, prisma } = fakePrisma(data);
  return { stub, service: new FamiliarPoolService(prisma, new CacheService()) };
}

describe('FamiliarPoolService', () => {
  // The headline claim: three different provider spellings of one song are one
  // candidate, with the evidence from all three attached.
  it('merges one song across library, playlist and history', async () => {
    const { service } = serviceWith({
      favorites: [favorite()],
      playlists: [playlist({ favorite: true, playCount: 20 })],
      history: [history()],
    });

    const pool = await service.pool('guild-1', ['u1']);

    expect(pool).toHaveLength(1);
    const [candidate] = pool;
    expect(candidate?.sources).toEqual(new Set(['library', 'playlist', 'history']));
    // Library metadata wins: a person curated that title, the rest are noise.
    expect(candidate?.title).toBe('Blinding Lights');
    expect(candidate?.identifier).toBe('fav-1');
    expect(candidate?.source).toBe('spotify');
    expect(candidate?.artworkUrl).toBe('https://art.test/blinding.jpg');
    expect(candidate?.plays).toBe(1);
    expect(candidate?.userPlays).toBe(1);
    expect(candidate?.completions).toBe(1);
    expect(candidate?.lastPlayedAt).toBe(new Date('2026-08-01T00:00:00Z').getTime());
  });

  // The anti-drift rule: autoplay must not be able to promote its own guesses
  // into "familiar" by having played them once.
  it('does not treat a single tolerated autoplay play as familiar', async () => {
    const { service } = serviceWith({
      history: [history({ origin: 'autoplay', playedMs: 60_000, skipped: false })],
    });

    expect(await service.pool('guild-1', ['u1'])).toEqual([]);
  });

  it('treats a completed autoplay play as familiar', async () => {
    const { service } = serviceWith({
      history: [history({ origin: 'autoplay', playedMs: 195_000 })],
    });

    const pool = await service.pool('guild-1', ['u1']);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.sources).toEqual(new Set(['history']));
    expect(pool[0]?.userPlays).toBe(0);
    expect(pool[0]?.completions).toBe(1);
  });

  // Coming back to something is an endorsement even when neither play finished.
  it('treats a replayed autoplay track as familiar and counts the replays', async () => {
    const { service } = serviceWith({
      history: [
        history({ origin: 'autoplay', playedMs: 60_000, playedAt: new Date('2026-08-02') }),
        history({ origin: 'autoplay', playedMs: 60_000, playedAt: new Date('2026-08-01') }),
      ],
    });

    const pool = await service.pool('guild-1', ['u1']);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.plays).toBe(2);
    expect(pool[0]?.completions).toBe(0);
    expect(pool[0]?.lastPlayedAt).toBe(new Date('2026-08-02').getTime());
  });

  it('marks a song someone asked for this week as requested, and an old request as history', async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const { service } = serviceWith({
      history: [
        history({ identifier: 'a', title: 'Fresh Request', playedAt: recent }),
        history({ identifier: 'b', title: 'Old Request', playedAt: old }),
      ],
    });

    const pool = await service.pool('guild-1', ['u1']);

    const fresh = pool.find((candidate) => candidate.title === 'Fresh Request');
    const stale = pool.find((candidate) => candidate.title === 'Old Request');
    expect(fresh?.sources.has('requested')).toBe(true);
    expect(stale?.sources.has('requested')).toBe(false);
    expect(stale?.sources.has('history')).toBe(true);
  });

  it('does not let an autoplay pick the room skipped twice count as familiar', async () => {
    const { service } = serviceWith({
      history: [
        history({ origin: 'autoplay', skipped: true, playedMs: 5_000 }),
        history({ origin: 'autoplay', skipped: true, playedMs: 8_000 }),
      ],
    });

    expect(await service.pool('guild-1', [])).toHaveLength(0);
  });

  it('strips uploader-channel suffixes from a history artist and prefers catalogue metadata', async () => {
    const { service } = serviceWith({
      history: [
        history({ identifier: 'yt', author: 'The Weeknd - Topic', source: DbMusicSource.YOUTUBE }),
        history({
          identifier: 'sp',
          author: 'The Weeknd',
          title: 'Blinding Lights',
          source: DbMusicSource.SPOTIFY,
        }),
      ],
    });

    const pool = await service.pool('guild-1', []);

    expect(pool).toHaveLength(1);
    expect(pool[0]?.artist).toBe('The Weeknd');
    expect(pool[0]?.title).toBe('Blinding Lights');
    expect(pool[0]?.source).toBe('spotify');
  });

  it('counts early skips separately from plays', async () => {
    const { service } = serviceWith({
      favorites: [favorite()],
      history: [
        history({ playedMs: 10_000, skipped: true }),
        history({ playedMs: 195_000, skipped: true, playedAt: new Date('2026-07-30') }),
      ],
    });

    const pool = await service.pool('guild-1', ['u1']);
    // Skipping the last seconds of a track is not a rejection; skipping it at
    // ten seconds is.
    expect(pool[0]?.earlySkips).toBe(1);
    expect(pool[0]?.completions).toBe(1);
  });

  it('counts distinct listeners once each', async () => {
    const { service } = serviceWith({
      favorites: [favorite({ user: { discordId: 'u1' } }), favorite({ user: { discordId: 'u2' } })],
      playlists: [playlist({ owner: { discordId: 'u2' } })],
      history: [history({ userId: null }), history({ userId: null })],
    });

    const pool = await service.pool('guild-1', ['u1', 'u2']);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.listenerCount).toBe(2);
  });

  // `Playlist.guildId` is the internal row id, so a shared playlist can only be
  // found through the relation — getting this wrong silently returns nothing.
  it('asks for guild-shared public playlists through the guild relation', async () => {
    const { stub, service } = serviceWith({ playlists: [playlist({ owner: null })] });

    await service.pool('guild-1', ['u1']);

    const args = stub.playlist.findMany.mock.calls[0]?.[0] as
      { where: { OR: readonly Record<string, unknown>[] } } | undefined;
    expect(args).toBeDefined();
    expect(args?.where.OR).toContainEqual({
      guild: { discordId: 'guild-1' },
      visibility: 'PUBLIC',
    });
    expect(args?.where.OR).toContainEqual({ owner: { discordId: { in: ['u1'] } } });
  });

  it('derives playlist relevance from starring and play count, keeping the best', async () => {
    const { service } = serviceWith({
      playlists: [
        playlist({ favorite: true, playCount: 20, tracks: [playlistTrack()] }),
        playlist({ favorite: false, playCount: 0, tracks: [playlistTrack()] }),
      ],
    });

    const pool = await service.pool('guild-1', ['u1']);
    expect(pool[0]?.playlistRelevance).toBeCloseTo(1);

    const { service: plain } = serviceWith({
      playlists: [playlist({ favorite: false, playCount: 5 })],
    });
    expect((await plain.pool('guild-1', ['u1']))[0]?.playlistRelevance).toBeCloseTo(0.25);
  });

  it('serves a second call from cache without touching the database', async () => {
    const { stub, service } = serviceWith({ favorites: [favorite()] });

    const first = await service.pool('guild-1', ['u1']);
    // Order must not split the cache entry — same room, same answer.
    const second = await service.pool('guild-1', ['u1']);

    expect(stub.favoriteTrack.findMany).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(first.length);
    // A Set does not survive JSON, so this is really a test of the rehydration.
    expect(second[0]?.sources).toEqual(new Set(['library']));
  });

  it('returns an empty pool when a query fails', async () => {
    const { service } = serviceWith({
      favorites: [favorite()],
      history: new Error('connection lost'),
    });

    expect(await service.pool('guild-1', ['u1'])).toEqual([]);
  });

  it('drops tracks too long to be radio material', async () => {
    const { service } = serviceWith({
      favorites: [favorite({ durationMs: 20 * 60_000 })],
      history: [history({ durationMs: 20 * 60_000, playedMs: 20 * 60_000 })],
    });

    expect(await service.pool('guild-1', ['u1'])).toEqual([]);
  });

  it('drops stream-like rows with neither duration nor address', async () => {
    const { service } = serviceWith({ favorites: [favorite({ durationMs: 0, uri: null })] });

    expect(await service.pool('guild-1', ['u1'])).toEqual([]);
  });

  it('skips the per-listener queries when nobody is identified', async () => {
    const { stub, service } = serviceWith({ history: [history({ userId: null })] });

    await service.pool('guild-1', []);

    expect(stub.favoriteTrack.findMany).not.toHaveBeenCalled();
    const args = stub.songHistory.findMany.mock.calls[0]?.[0] as
      { where: { OR: readonly Record<string, unknown>[] } } | undefined;
    expect(args).toBeDefined();
    expect(args?.where.OR).toEqual([{ guild: { discordId: 'guild-1' } }]);
  });
});

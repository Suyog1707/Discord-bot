import type { PrismaClient } from '@discord-music/database';
import { describe, expect, it, vi } from 'vitest';

import { CacheService } from './cache.js';
import {
  CooccurrenceService,
  neighbourhoodScore,
  similarityBetween,
  type CooccurrenceSignals,
} from './cooccurrence.js';
import { identityOf } from './identity.js';

/**
 * Prisma is stubbed rather than run: every rule under test is pure once the
 * rows are in hand, and the interesting cases (a severed chain, a pair that is
 * adjacent *and* same-day) are far easier to state as rows than as fixtures.
 */
interface HistoryRow {
  identifier: string;
  title: string;
  author: string;
  playedMs: number;
  durationMs: number;
  skipped: boolean;
  playedAt: Date;
  userId: string | null;
  guildId: string;
}

interface TrackRow {
  title: string;
  author: string;
}

interface PlaylistRow {
  tracks: TrackRow[];
}

interface FavoriteRow {
  title: string;
  author: string;
  user: { discordId: string } | null;
}

const BASE = new Date('2026-08-01T20:00:00Z').getTime();

/** Minutes after the start of the session. */
function at(minutes: number): Date {
  return new Date(BASE + minutes * 60_000);
}

function history(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    identifier: 'yt-a',
    title: 'Song A',
    author: 'Artist A',
    playedMs: 200_000,
    durationMs: 200_000,
    skipped: false,
    playedAt: at(0),
    // Null by default so a test that is about adjacency is not also about the
    // same-day pass silently pairing everything with everything.
    userId: null,
    guildId: 'guild-row-1',
    ...overrides,
  };
}

function fakePrisma(data: {
  history?: HistoryRow[] | Error;
  playlists?: PlaylistRow[] | Error;
  favorites?: FavoriteRow[] | Error;
}) {
  // The argument is typed `unknown` rather than dropped so the tests that
  // assert on the generated `where` clause can read it back.
  const answer = <T>(value: T[] | Error | undefined) =>
    vi.fn((_args: unknown): Promise<T[]> =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []),
    );

  const stub = {
    songHistory: { findMany: answer<HistoryRow>(data.history) },
    playlist: { findMany: answer<PlaylistRow>(data.playlists) },
    favoriteTrack: { findMany: answer<FavoriteRow>(data.favorites) },
  };

  return { stub, prisma: stub as unknown as PrismaClient };
}

function serviceWith(data: Parameters<typeof fakePrisma>[0]) {
  const { stub, prisma } = fakePrisma(data);
  return { stub, service: new CooccurrenceService(prisma, new CacheService()) };
}

const A = identityOf('Artist A', 'Song A');
const B = identityOf('Artist B', 'Song B');
const C = identityOf('Artist C', 'Song C');
const D = identityOf('Artist D', 'Song D');
const E = identityOf('Artist E', 'Song E');

const songA = { title: 'Song A', author: 'Artist A' };
const songB = { title: 'Song B', author: 'Artist B' };

/** The directed edge, which is where the raw weight ratios are still visible. */
function edge(signals: CooccurrenceSignals, from: string, to: string): number | undefined {
  return signals.tracks.get(from)?.get(to);
}

describe('CooccurrenceService', () => {
  it('pairs two songs played back to back in the same guild', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
      ],
    });

    const signals = await service.signals('guild-1', []);

    expect(similarityBetween(signals, A.key, B.key)).toBe(1);
    // Symmetric: with one pair each row's only neighbour is its strongest.
    expect(similarityBetween(signals, B.key, A.key)).toBe(1);
    expect(edge(signals, A.key, B.key)).toBe(1);
    expect(edge(signals, B.key, A.key)).toBe(1);
  });

  it('does not pair plays that are half an hour apart', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(25) }),
      ],
    });

    const signals = await service.signals('guild-1', []);

    expect(signals.tracks.size).toBe(0);
    expect(similarityBetween(signals, A.key, B.key)).toBe(0);
  });

  // The point of the completion rule: the room did not hear A next to C, it
  // heard A, then rejected something, then heard C.
  it('lets an abandoned play break the chain rather than closing over it', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({
          ...songB,
          identifier: 'yt-b',
          playedAt: at(5),
          playedMs: 8_000,
          skipped: true,
        }),
        history({ title: 'Song C', author: 'Artist C', identifier: 'yt-c', playedAt: at(10) }),
      ],
    });

    const signals = await service.signals('guild-1', []);

    expect(signals.tracks.size).toBe(0);
    expect(similarityBetween(signals, A.key, C.key)).toBe(0);
    expect(similarityBetween(signals, A.key, B.key)).toBe(0);
  });

  it('pairs songs one person played in the same day at half the weight', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0), userId: 'user-1' }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5), userId: 'user-1' }),
        history({
          title: 'Song C',
          author: 'Artist C',
          identifier: 'yt-c',
          playedAt: at(180),
          userId: 'user-1',
        }),
      ],
    });

    const signals = await service.signals('guild-1', ['u1']);

    // A and B are adjacent (1.0) and must not also collect the same-day 0.5;
    // A and C only ever shared a day.
    expect(edge(signals, A.key, B.key)).toBe(1);
    expect(edge(signals, A.key, C.key)).toBeCloseTo(0.5);
  });

  it('pairs playlist neighbours below an adjacency', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
      ],
      playlists: [{ tracks: [songA, { title: 'Song D', author: 'Artist D' }] }],
    });

    const signals = await service.signals('guild-1', ['u1']);

    expect(edge(signals, A.key, B.key)).toBe(1);
    expect(edge(signals, A.key, D.key)).toBeCloseTo(0.6);
  });

  it('pairs one listener saved tracks at the weakest weight', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
      ],
      favorites: [
        { ...songA, user: { discordId: 'u1' } },
        { title: 'Song E', author: 'Artist E', user: { discordId: 'u1' } },
      ],
    });

    const signals = await service.signals('guild-1', ['u1']);

    expect(edge(signals, A.key, E.key)).toBeCloseTo(0.4);
  });

  // Repetition accumulates, then the row is rescaled: the strongest neighbour
  // of a song is always exactly 1, whatever the raw totals were.
  it('accumulates repeated evidence and normalises each row to its strongest neighbour', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
        history({ ...songA, playedAt: at(600) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(605) }),
      ],
      playlists: [{ tracks: [songA, { title: 'Song D', author: 'Artist D' }] }],
    });

    const signals = await service.signals('guild-1', ['u1']);

    // Raw weights are 2.0 (two adjacencies) and 0.6 (one playlist).
    expect(edge(signals, A.key, B.key)).toBe(1);
    expect(edge(signals, A.key, D.key)).toBeCloseTo(0.3);
  });

  it('builds the artist graph from the same pairs and never pairs an artist with themselves', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
      ],
    });

    const signals = await service.signals('guild-1', []);
    expect(signals.artists.get(A.artistKey)?.get(B.artistKey)).toBe(1);
    expect(signals.artists.get(B.artistKey)?.get(A.artistKey)).toBe(1);

    // Two songs by one artist are a track pair and no artist pair at all.
    const { service: sameArtist } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ title: 'Song A2', author: 'Artist A', identifier: 'yt-a2', playedAt: at(5) }),
      ],
    });

    const solo = await sameArtist.signals('guild-1', []);
    expect(solo.tracks.size).toBe(2);
    expect(solo.artists.size).toBe(0);
  });

  it('keeps adjacency inside one guild', async () => {
    const { service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0), guildId: 'guild-row-1' }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5), guildId: 'guild-row-2' }),
      ],
    });

    const signals = await service.signals('guild-1', ['u1']);
    expect(signals.tracks.size).toBe(0);
  });

  it('serves a second call from cache without touching the database', async () => {
    const { stub, service } = serviceWith({
      history: [
        history({ ...songA, playedAt: at(0) }),
        history({ ...songB, identifier: 'yt-b', playedAt: at(5) }),
      ],
    });

    await service.signals('guild-1', ['u2', 'u1']);
    // Listener order must not split the cache entry - same room, same answer.
    const second = await service.signals('guild-1', ['u1', 'u2']);

    expect(stub.songHistory.findMany).toHaveBeenCalledTimes(1);
    expect(stub.playlist.findMany).toHaveBeenCalledTimes(1);
    // A Map does not survive JSON, so this is really a test of the rehydration.
    expect(second.tracks.get(A.key)).toBeInstanceOf(Map);
    expect(second.tracks.get(A.key)?.get(B.key)).toBe(1);
    expect(second.artists.get(A.artistKey)?.get(B.artistKey)).toBe(1);
  });

  it('returns empty signals when a query fails', async () => {
    const { service } = serviceWith({ history: new Error('connection lost') });

    const signals = await service.signals('guild-1', ['u1']);

    expect(signals.tracks.size).toBe(0);
    expect(signals.artists.size).toBe(0);
  });

  it('still reads the guild history when nobody is identified', async () => {
    const { stub, service } = serviceWith({ history: [history()] });

    await service.signals('guild-1', []);

    expect(stub.favoriteTrack.findMany).not.toHaveBeenCalled();
    const args = stub.songHistory.findMany.mock.calls[0]?.[0] as
      { where: { OR: readonly Record<string, unknown>[] } } | undefined;
    expect(args).toBeDefined();
    expect(args?.where.OR).toEqual([{ guild: { discordId: 'guild-1' } }]);
    // The guild's own public playlists exist with or without a listener.
    expect(stub.playlist.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('neighbourhoodScore', () => {
  const signals: CooccurrenceSignals = {
    tracks: new Map([['cand', new Map([['seed-track', 0.5]])]]),
    artists: new Map([['cand-artist', new Map([['seed-artist', 1]])]]),
  };

  it('blends the track and artist neighbourhoods', () => {
    expect(
      neighbourhoodScore(signals, 'cand', 'cand-artist', ['seed-track'], ['seed-artist']),
    ).toBeCloseTo(0.7 * 0.5 + 0.3 * 1);
  });

  it('scores an unrelated candidate at zero and takes the best seed', () => {
    expect(
      neighbourhoodScore(signals, 'other', 'other-artist', ['seed-track'], ['seed-artist']),
    ).toBe(0);
    expect(
      neighbourhoodScore(signals, 'cand', 'cand-artist', ['nothing', 'seed-track'], []),
    ).toBeCloseTo(0.35);
  });

  it('stays inside 0..1 when both neighbourhoods are maximal', () => {
    const strong: CooccurrenceSignals = {
      tracks: new Map([['cand', new Map([['seed-track', 1]])]]),
      artists: new Map([['cand-artist', new Map([['seed-artist', 1]])]]),
    };

    expect(neighbourhoodScore(strong, 'cand', 'cand-artist', ['seed-track'], ['seed-artist'])).toBe(
      1,
    );
  });
});

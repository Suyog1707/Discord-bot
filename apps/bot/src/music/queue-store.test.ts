import type { PrismaClient } from '@discord-music/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueueStore } from './queue-store.js';
import { TrackQueue } from './track-queue.js';
import type { QueuedTrack } from './track.js';

function track(
  id: string,
  requestedById: string,
  origin: 'user' | 'autoplay' = 'user',
): QueuedTrack {
  return {
    encoded: `enc-${id}`,
    identifier: id,
    title: `Song ${id}`,
    author: 'Artist',
    durationMs: 200_000,
    uri: null,
    artworkUrl: null,
    isStream: false,
    source: 'spotify',
    requestedById,
    requestedByName: origin === 'autoplay' ? 'Autoplay' : 'Someone',
    origin,
    ...(origin === 'autoplay' ? { autoplayKind: 'familiar' as const } : {}),
  };
}

/**
 * A fake Prisma that remembers what the store wrote, so a save can be read
 * back through `loadPersisted` — the round trip a restart actually performs.
 *
 * Rows are keyed by voice channel, exactly as the table now is: that is what
 * lets a test show two channels in one guild keeping separate queues.
 */
function fakePrisma() {
  const users = new Map([
    [
      '111111111111111111',
      { id: 'u-1', discordId: '111111111111111111', username: 'ann', globalName: 'Ann' },
    ],
    [
      '222222222222222222',
      { id: 'u-2', discordId: '222222222222222222', username: 'bob', globalName: null },
    ],
  ]);

  interface Row {
    row: Record<string, unknown>;
    tracks: Record<string, unknown>[];
  }
  /** voiceChannelId -> its stored queue. */
  const rows = new Map<string, Row>();
  const byId = (queueId: unknown): Row | undefined =>
    [...rows.values()].find((entry) => entry.row.id === queueId);

  const userOf = (rowId: unknown) => [...users.values()].find((user) => user.id === rowId);

  const tx = { deleteMany: vi.fn(), update: vi.fn(), createMany: vi.fn() };
  const prisma = {
    guild: { findUnique: vi.fn(() => Promise.resolve({ id: 'g-1' })) },
    user: {
      findMany: vi.fn(({ where }: { where: { discordId: { in: string[] } } }) =>
        Promise.resolve(
          where.discordId.in.flatMap((id) => {
            const user = users.get(id);
            return user === undefined ? [] : [{ id: user.id, discordId: user.discordId }];
          }),
        ),
      ),
    },
    queue: {
      upsert: vi.fn(
        ({
          where,
        }: {
          where: { guildId_voiceChannelId: { guildId: string; voiceChannelId: string } };
        }) => {
          const { voiceChannelId } = where.guildId_voiceChannelId;
          const existing = rows.get(voiceChannelId);
          if (existing !== undefined) return Promise.resolve({ id: existing.row.id });
          const row: Row = {
            row: {
              id: `q-${voiceChannelId}`,
              currentIndex: 0,
              loopMode: 'OFF',
              volume: 100,
              voiceChannelId,
              textChannelId: null,
              listenerId: null,
              updatedAt: new Date(),
            },
            tracks: [],
          };
          rows.set(voiceChannelId, row);
          return Promise.resolve({ id: row.row.id });
        },
      ),
      update: vi.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = byId(args.where.id);
        if (entry !== undefined) {
          entry.row = { ...entry.row, ...args.data, updatedAt: new Date() };
        }
        return tx.update;
      }),
      findFirst: vi.fn(({ where }: { where: { voiceChannelId: string } }) => {
        const entry = rows.get(where.voiceChannelId);
        if (entry === undefined) return Promise.resolve(null);
        return Promise.resolve({
          ...entry.row,
          listener:
            entry.row.listenerId === null
              ? null
              : { discordId: userOf(entry.row.listenerId)?.discordId },
          tracks: entry.tracks.map((row) => ({
            ...row,
            requestedBy:
              row.requestedById === null
                ? null
                : (() => {
                    const user = userOf(row.requestedById);
                    return user === undefined
                      ? null
                      : {
                          discordId: user.discordId,
                          username: user.username,
                          globalName: user.globalName,
                        };
                  })(),
          })),
        });
      }),
    },
    queueTrack: {
      deleteMany: vi.fn((args: { where: { queueId: string } }) => {
        const entry = byId(args.where.queueId);
        if (entry !== undefined) entry.tracks = [];
        return tx.deleteMany;
      }),
      createMany: vi.fn((args: { data: Record<string, unknown>[] }) => {
        for (const row of args.data) {
          const entry = byId(row.queueId);
          if (entry !== undefined) entry.tracks.push({ ...row, playbackSource: null });
        }
        return tx.createMany;
      }),
    },
    $transaction: vi.fn(() => Promise.resolve([])),
  };
  return prisma as unknown as PrismaClient;
}

/** The debounced save, flushed by advancing the fake clock past its window. */
async function save(
  store: QueueStore,
  queue: TrackQueue,
  listenerId: string | null,
  voiceChannelId = 'v',
): Promise<void> {
  store.scheduleSave('guild', queue, {
    volume: 100,
    paused: false,
    voiceChannelId,
    textChannelId: 't',
    listenerId,
  });
  await vi.advanceTimersByTimeAsync(2_000);
}

describe('QueueStore — listener identity survives a save/restore round trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the requester, origin, cadence kind and listener, and reads them back', async () => {
    const prisma = fakePrisma();
    const store = new QueueStore(prisma);
    const queue = new TrackQueue();
    queue.add([
      track('a', '111111111111111111'),
      track('b', '222222222222222222'),
      track('c', '0', 'autoplay'),
    ]);
    queue.advance();

    await save(store, queue, '111111111111111111');

    const persisted = await store.loadPersisted('guild', 'v');
    expect(persisted).not.toBeNull();
    if (persisted === null) return;
    expect(persisted.listenerId).toBe('111111111111111111');
    expect(persisted.tracks.map((entry) => entry.requestedById)).toEqual([
      '111111111111111111',
      '222222222222222222',
      '0',
    ]);
    expect(persisted.tracks.map((entry) => entry.requestedByName)).toEqual([
      'Ann',
      'bob',
      'Autoplay',
    ]);
    expect(persisted.tracks.map((entry) => entry.origin)).toEqual(['user', 'user', 'autoplay']);
    expect(persisted.tracks[2]?.autoplayKind).toBe('familiar');
  });

  it('leaves a requester the database has never met unattributed rather than failing the save', async () => {
    const prisma = fakePrisma();
    const store = new QueueStore(prisma);
    const queue = new TrackQueue();
    queue.add([track('a', '999999999999999999')]);

    await save(store, queue, '999999999999999999');
    const persisted = await store.loadPersisted('guild', 'v');

    expect(persisted?.listenerId).toBeNull();
    expect(persisted?.tracks[0]?.requestedByName).toBe('Restored');
  });
});

describe('QueueStore — one queue per voice channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps two channels of one guild apart instead of overwriting', async () => {
    const prisma = fakePrisma();
    const store = new QueueStore(prisma);

    const roomOne = new TrackQueue();
    roomOne.add([track('a', '111111111111111111'), track('b', '111111111111111111')]);
    await save(store, roomOne, '111111111111111111', 'vc-1');

    // The bot moves: the second room saves over the top of the first, which
    // is precisely what used to destroy it.
    const roomTwo = new TrackQueue();
    roomTwo.add([track('z', '222222222222222222')]);
    await save(store, roomTwo, '222222222222222222', 'vc-2');

    const one = await store.loadPersisted('guild', 'vc-1');
    const two = await store.loadPersisted('guild', 'vc-2');

    expect(one?.tracks.map((entry) => entry.identifier)).toEqual(['a', 'b']);
    expect(one?.listenerId).toBe('111111111111111111');
    expect(two?.tracks.map((entry) => entry.identifier)).toEqual(['z']);
    expect(two?.listenerId).toBe('222222222222222222');
  });

  it('reports nothing for a channel the bot has never played in', async () => {
    const store = new QueueStore(fakePrisma());

    expect(await store.loadPersisted('guild', 'vc-never')).toBeNull();
  });

  it("does not let one channel's pending save cancel another's", async () => {
    const prisma = fakePrisma();
    const store = new QueueStore(prisma);

    const roomOne = new TrackQueue();
    roomOne.add([track('a', '111111111111111111')]);
    const roomTwo = new TrackQueue();
    roomTwo.add([track('z', '222222222222222222')]);

    // Both scheduled inside one debounce window — the bot leaving vc-1 and
    // arriving in vc-2 is exactly this shape.
    store.scheduleSave('guild', roomOne, {
      volume: 100,
      paused: false,
      voiceChannelId: 'vc-1',
      textChannelId: 't',
      listenerId: null,
    });
    store.scheduleSave('guild', roomTwo, {
      volume: 100,
      paused: false,
      voiceChannelId: 'vc-2',
      textChannelId: 't',
      listenerId: null,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await store.loadPersisted('guild', 'vc-1'))?.tracks).toHaveLength(1);
    expect((await store.loadPersisted('guild', 'vc-2'))?.tracks).toHaveLength(1);
  });
});

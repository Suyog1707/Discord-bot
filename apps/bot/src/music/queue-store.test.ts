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
  let queueRow: Record<string, unknown> = {
    id: 'q-1',
    currentIndex: 0,
    loopMode: 'OFF',
    volume: 100,
    voiceChannelId: 'v',
    textChannelId: 't',
    listenerId: null,
  };
  let trackRows: Record<string, unknown>[] = [];
  const tx = { deleteMany: vi.fn(), update: vi.fn(), createMany: vi.fn() };
  const prisma = {
    guild: { findUnique: vi.fn(() => Promise.resolve({ id: 'g-1', queue: { id: 'q-1' } })) },
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
      create: vi.fn(),
      update: vi.fn((args: { data: Record<string, unknown> }) => {
        queueRow = { ...queueRow, ...args.data };
        return tx.update;
      }),
      findFirst: vi.fn(() =>
        Promise.resolve({
          ...queueRow,
          listener:
            queueRow.listenerId === null
              ? null
              : {
                  discordId: [...users.values()].find((u) => u.id === queueRow.listenerId)
                    ?.discordId,
                },
          tracks: trackRows.map((row) => ({
            ...row,
            requestedBy:
              row.requestedById === null
                ? null
                : (() => {
                    const user = [...users.values()].find((u) => u.id === row.requestedById);
                    return user === undefined
                      ? null
                      : {
                          discordId: user.discordId,
                          username: user.username,
                          globalName: user.globalName,
                        };
                  })(),
          })),
        }),
      ),
    },
    queueTrack: {
      deleteMany: vi.fn(() => tx.deleteMany),
      createMany: vi.fn((args: { data: Record<string, unknown>[] }) => {
        trackRows = args.data.map((row) => ({ ...row, playbackSource: null }));
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
): Promise<void> {
  store.scheduleSave('guild', queue, {
    volume: 100,
    paused: false,
    voiceChannelId: 'v',
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

    const persisted = await store.loadPersisted('guild');
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
    const persisted = await store.loadPersisted('guild');

    expect(persisted?.listenerId).toBeNull();
    expect(persisted?.tracks[0]?.requestedByName).toBe('Restored');
  });
});

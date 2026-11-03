/**
 * Picking the music back up after a restart.
 *
 * Every bot keeps a small record of the rooms it is *actively playing* in —
 * which track, how far in, and when that was last true — and on startup it
 * rejoins exactly those rooms and carries on. These tests pin the three
 * halves of that: the tracker that keeps the records honest while the bot
 * runs (and, above all, while it shuts down), the decision about which saved
 * rooms are worth rejoining, and the restore loop that turns a record into a
 * join without ever letting two bots take the same room.
 *
 * Everything runs against fakes. The Redis half is pinned by call shape only;
 * the claim itself is a Lua script, and a fake Redis would only test the fake.
 */
import {
  botClaimKey,
  CLAIM_TTL_MS,
  playerBotIndexKey,
  playerRoomOwnerKey,
  roomClaimKey,
} from '@discord-music/shared';
import { describe, expect, it, vi } from 'vitest';

import type { PersistedQueue } from './queue-store.js';
import {
  CLAIM_ROOM_FOR_RESUME_SCRIPT,
  chooseStartPoint,
  decideRoomResume,
  decideStayConnectedRestore,
  RedisResumeStore,
  restorePlayingRooms,
  RESUME_MAX_AGE_MS,
  RESUME_RECORD_TTL_SECONDS,
  resumeRecordsKey,
  ResumeTracker,
  type PlayingRoomView,
  type RestoreRoomsDeps,
  type ResumeRecord,
  type ResumeStore,
} from './room-resume.js';
import type { QueuedTrack } from './track.js';

const NOW = 1_800_000_000_000;
const GUILD = '111111111111111111';
const ROOM = '222222222222222222';
const OTHER_ROOM = '333333333333333333';
const TEXT = '444444444444444444';

/* ------------------------------------------------------------------ fixtures */

function track(id: string, overrides: Partial<QueuedTrack> = {}): QueuedTrack {
  return {
    encoded: `encoded-${id}`,
    identifier: id,
    title: `Song ${id}`,
    author: 'Artist',
    durationMs: 200_000,
    uri: null,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: '555555555555555555',
    requestedByName: 'Tester',
    origin: 'user',
    ...overrides,
  };
}

function record(overrides: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    guildId: GUILD,
    voiceChannelId: ROOM,
    textChannelId: TEXT,
    trackIdentifier: 'b',
    currentIndex: 1,
    positionMs: 73_000,
    savedAt: NOW - 30_000,
    ...overrides,
  };
}

function queue(overrides: Partial<PersistedQueue> = {}): PersistedQueue {
  return {
    tracks: [track('a'), track('b'), track('c')],
    currentIndex: 1,
    loopMode: 'off',
    volume: 80,
    voiceChannelId: ROOM,
    textChannelId: TEXT,
    listenerId: null,
    savedAt: new Date(NOW - 30_000),
    ...overrides,
  };
}

function view(overrides: Partial<PlayingRoomView> = {}): PlayingRoomView {
  return {
    guildId: GUILD,
    voiceChannelId: ROOM,
    textChannelId: TEXT,
    isPlaying: true,
    paused: false,
    currentIdentifier: 'b',
    currentIndex: 1,
    positionMs: 42_000,
    ...overrides,
  };
}

const roomKey = (guildId: string, voiceChannelId: string): string => `${guildId}:${voiceChannelId}`;

/**
 * The whole fleet's records and claims, in memory.
 *
 * Records are per bot, exactly as in Redis; claims are shared, which is what
 * lets two bots' restores race for one room in a test.
 */
function fakeFleet() {
  const records = new Map<string, Map<string, ResumeRecord>>();
  const roomClaims = new Map<string, string>();
  const owners = new Map<string, string>();

  const storeFor = (botId: string): ResumeStore & { readonly claim: ReturnType<typeof vi.fn> } => {
    const mine = (): Map<string, ResumeRecord> => {
      let found = records.get(botId);
      if (found === undefined) {
        found = new Map();
        records.set(botId, found);
      }
      return found;
    };
    return {
      save: vi.fn((value: ResumeRecord) => {
        mine().set(roomKey(value.guildId, value.voiceChannelId), value);
        return Promise.resolve();
      }),
      remove: vi.fn((guildId: string, voiceChannelId: string) => {
        mine().delete(roomKey(guildId, voiceChannelId));
        return Promise.resolve();
      }),
      loadAll: vi.fn(() => Promise.resolve([...mine().values()])),
      claim: vi.fn(
        async (
          guildId: string,
          voiceChannelId: string,
          options: { readonly respectOwner: boolean },
        ) => {
          // A real round trip, so two concurrent restores interleave.
          await Promise.resolve();
          const key = roomKey(guildId, voiceChannelId);
          const holder = roomClaims.get(key);
          if (holder !== undefined && holder !== botId) return false;
          const owner = owners.get(key);
          if (options.respectOwner && owner !== undefined && owner !== botId) return false;
          roomClaims.set(key, botId);
          return true;
        },
      ),
      release: vi.fn((guildId: string, voiceChannelId: string) => {
        const key = roomKey(guildId, voiceChannelId);
        if (roomClaims.get(key) === botId) roomClaims.delete(key);
        return Promise.resolve();
      }),
      heldElsewhere: vi.fn((guildId: string, voiceChannelId: string, now: number) => {
        for (const [other, held] of records) {
          if (other === botId) continue;
          const found = held.get(roomKey(guildId, voiceChannelId));
          if (found !== undefined && now - found.savedAt <= RESUME_MAX_AGE_MS) {
            return Promise.resolve(other);
          }
        }
        return Promise.resolve(undefined);
      }),
    };
  };

  return { records, roomClaims, owners, storeFor };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

interface DepsOptions {
  readonly store: ResumeStore;
  readonly guildPresent?: boolean;
  readonly channelIsVoice?: boolean;
  readonly humans?: number;
  readonly hasPlayer?: boolean;
  readonly saved?: PersistedQueue | null;
  readonly startRoom?: RestoreRoomsDeps['startRoom'];
}

function deps(options: DepsOptions): RestoreRoomsDeps & {
  readonly startRoom: ReturnType<typeof vi.fn>;
  readonly logger: ReturnType<typeof logger>;
} {
  return {
    store: options.store,
    now: () => NOW,
    guildPresent: () => options.guildPresent ?? true,
    channelIsVoice: () => options.channelIsVoice ?? true,
    humanListeners: () => options.humans ?? 2,
    hasPlayer: () => options.hasPlayer ?? false,
    loadQueue: vi.fn(() => Promise.resolve(options.saved === undefined ? queue() : options.saved)),
    startRoom: vi.fn(options.startRoom ?? (() => Promise.resolve())),
    logger: logger(),
  };
}

/* ------------------------------------------------------------ the decision */

describe('decideRoomResume', () => {
  const facts = {
    record: record(),
    now: NOW,
    guildPresent: true,
    channelIsVoice: true,
    humanListeners: 1,
    hasPlayer: false,
  };

  it('restores a fresh record for a room people are sitting in', () => {
    expect(decideRoomResume(facts)).toEqual({ kind: 'restore' });
  });

  it.each([
    ['stale', { record: record({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 }) }],
    ['not-in-guild', { guildPresent: false }],
    ['channel-gone', { channelIsVoice: false }],
    ['no-listeners', { humanListeners: 0 }],
    ['already-active', { hasPlayer: true }],
  ] as const)('skips with reason %s', (reason, overrides) => {
    expect(decideRoomResume({ ...facts, ...overrides })).toEqual({ kind: 'skip', reason });
  });

  it('treats exactly the age limit as still fresh', () => {
    expect(
      decideRoomResume({ ...facts, record: record({ savedAt: NOW - RESUME_MAX_AGE_MS }) }),
    ).toEqual({ kind: 'restore' });
  });
});

describe('chooseStartPoint', () => {
  it('continues the saved track at the saved position', () => {
    expect(chooseStartPoint(record(), queue())).toEqual({ index: 1, positionMs: 73_000 });
  });

  it('follows the record when the queue row lags behind it', () => {
    // The debounced queue save had not caught up with the track change yet.
    expect(chooseStartPoint(record({ trackIdentifier: 'c', currentIndex: 2 }), queue())).toEqual({
      index: 2,
      positionMs: 73_000,
    });
  });

  it('starts the saved cursor from the top when the record names some other track', () => {
    expect(chooseStartPoint(record({ trackIdentifier: 'zzz', currentIndex: 7 }), queue())).toEqual({
      index: 1,
      positionMs: 0,
    });
  });

  it('never seeks a stream', () => {
    const live = queue({ tracks: [track('a'), track('b', { isStream: true })] });
    expect(chooseStartPoint(record(), live)).toEqual({ index: 1, positionMs: 0 });
  });

  it('never seeks past the end of the track', () => {
    expect(chooseStartPoint(record({ positionMs: 500_000 }), queue())).toEqual({
      index: 1,
      positionMs: 0,
    });
  });
});

/* -------------------------------------------------------- the restore loop */

describe('restorePlayingRooms', () => {
  it('rejoins an owned playing room and plays from the saved position', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('player-3');
    await store.save(record());
    const d = deps({ store });

    const summary = await restorePlayingRooms(d);

    expect(d.startRoom).toHaveBeenCalledTimes(1);
    expect(d.startRoom).toHaveBeenCalledWith(
      expect.objectContaining({ record: record(), index: 1, positionMs: 73_000 }),
    );
    expect(store.claim).toHaveBeenCalledWith(GUILD, ROOM, { respectOwner: true });
    expect(summary.restored).toEqual([
      expect.objectContaining({ guildId: GUILD, voiceChannelId: ROOM, positionMs: 73_000 }),
    ]);
    expect(summary.skipped).toEqual([]);
    // One line per room, and one summary.
    expect(d.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD, voiceChannelId: ROOM }),
      expect.stringMatching(/restored/iu),
    );
    expect(d.logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ restored: 1, skipped: 0, failed: 0 }),
      expect.any(String),
    );
  });

  it.each([
    ['stale', { savedAt: NOW - RESUME_MAX_AGE_MS - 60_000 }, {}],
    ['no-listeners', {}, { humans: 0 }],
    ['channel-gone', {}, { channelIsVoice: false }],
    ['not-in-guild', {}, { guildPresent: false }],
    ['already-active', {}, { hasPlayer: true }],
    ['empty-queue', {}, { saved: null }],
  ] as const)(
    'skips a %s room, says why, and forgets it',
    async (reason, recordOverrides, facts) => {
      const fleet = fakeFleet();
      const store = fleet.storeFor('main');
      await store.save(record(recordOverrides));
      const d = deps({ store, ...facts });

      const summary = await restorePlayingRooms(d);

      expect(d.startRoom).not.toHaveBeenCalled();
      expect(summary.skipped).toEqual([{ guildId: GUILD, voiceChannelId: ROOM, reason }]);
      expect(d.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: GUILD, voiceChannelId: ROOM, reason }),
        expect.any(String),
      );
      // A room that was not picked up now must not be picked up by some later
      // restart either.
      expect(await store.loadAll()).toEqual([]);
    },
  );

  it('never claims a room it has already decided to skip', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    await store.save(record());
    await restorePlayingRooms(deps({ store, humans: 0 }));
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('a paused room is simply never on the list', async () => {
    // Pausing removes the record (see the tracker below), so there is nothing
    // to restore — the loop does not have to know what "paused" means.
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    const tracker = new ResumeTracker(store, () => NOW);
    await tracker.sync(view());
    await tracker.sync(view({ paused: true }));
    const d = deps({ store });

    const summary = await restorePlayingRooms(d);

    expect(d.startRoom).not.toHaveBeenCalled();
    expect(summary).toEqual({ restored: [], skipped: [], failed: [] });
  });

  it("does not restore another bot's room", async () => {
    const fleet = fakeFleet();
    await fleet.storeFor('player-2').save(record());
    const d = deps({ store: fleet.storeFor('player-3') });

    const summary = await restorePlayingRooms(d);

    expect(d.startRoom).not.toHaveBeenCalled();
    expect(summary.restored).toEqual([]);
  });

  it('skips a room another bot holds, without joining it', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('player-2');
    await store.save(record());
    // A /play landed during startup and the router promised the room to
    // somebody else first.
    fleet.roomClaims.set(roomKey(GUILD, ROOM), 'player-5');
    const d = deps({ store });

    const summary = await restorePlayingRooms(d);

    expect(d.startRoom).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { guildId: GUILD, voiceChannelId: ROOM, reason: 'claimed-elsewhere' },
    ]);
  });

  it('lets exactly one bot restore a room two of them remember', async () => {
    // Bot A crashed out of the room and bot B took it over, both within the
    // age limit: both records are fresh. The claim decides, and only once.
    const fleet = fakeFleet();
    const a = fleet.storeFor('player-2');
    const b = fleet.storeFor('player-3');
    await a.save(record());
    await b.save(record({ positionMs: 90_000, savedAt: NOW - 5_000 }));
    const da = deps({ store: a });
    const db = deps({ store: b });

    const [first, second] = await Promise.all([restorePlayingRooms(da), restorePlayingRooms(db)]);

    expect(da.startRoom.mock.calls.length + db.startRoom.mock.calls.length).toBe(1);
    expect(first.restored.length + second.restored.length).toBe(1);
    expect([...first.skipped, ...second.skipped]).toEqual([
      { guildId: GUILD, voiceChannelId: ROOM, reason: 'claimed-elsewhere' },
    ]);
  });

  it('releases the claim once the room is started, and after a failed start', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    await store.save(record());
    await store.save(record({ voiceChannelId: OTHER_ROOM }));
    let calls = 0;
    const d = deps({
      store,
      startRoom: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve() : Promise.reject(new Error('voice join failed'));
      },
    });

    const summary = await restorePlayingRooms(d);

    expect(summary.restored).toHaveLength(1);
    expect(summary.failed).toEqual([
      expect.objectContaining({ guildId: GUILD, voiceChannelId: OTHER_ROOM }),
    ]);
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(fleet.roomClaims.size).toBe(0);
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it('restores a 24/7 room that was playing, like any other playing room', async () => {
    // Nothing about 24/7 changes the record: it exists because the room was
    // playing, so the room comes back playing.
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    await store.save(record());
    const d = deps({ store });

    await restorePlayingRooms(d);

    expect(d.startRoom).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, positionMs: 73_000 }),
    );
  });

  it('survives a store that cannot be read', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    vi.mocked(store.loadAll).mockRejectedValueOnce(new Error('redis down'));
    const d = deps({ store });

    await expect(restorePlayingRooms(d)).resolves.toEqual({
      restored: [],
      skipped: [],
      failed: [],
    });
    expect(d.logger.warn).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ 24/7 gating */

describe('decideStayConnectedRestore', () => {
  it('rejoins and waits when nobody restored the room playing', () => {
    expect(
      decideStayConnectedRestore({ hasPlayer: false, heldBy: undefined, humanListeners: 3 }),
    ).toBe('restore');
  });

  it('leaves a room this bot already resumed playing alone', () => {
    expect(
      decideStayConnectedRestore({ hasPlayer: true, heldBy: undefined, humanListeners: 3 }),
    ).toBe('already-playing');
  });

  it('leaves a room another bot is about to resume playing alone', () => {
    expect(
      decideStayConnectedRestore({ hasPlayer: false, heldBy: 'player-4', humanListeners: 1 }),
    ).toBe('resumed-by-another-bot');
  });

  it('still rejoins an empty 24/7 room another bot will not resume', () => {
    // The other bot skips it for having no listeners, so 24/7 must not.
    expect(
      decideStayConnectedRestore({ hasPlayer: false, heldBy: 'player-4', humanListeners: 0 }),
    ).toBe('restore');
  });
});

/* ------------------------------------------------------------- the tracker */

describe('ResumeTracker', () => {
  it('records a playing room with its position', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    const tracker = new ResumeTracker(store, () => NOW);

    await tracker.sync(view());

    expect(await store.loadAll()).toEqual([
      {
        guildId: GUILD,
        voiceChannelId: ROOM,
        textChannelId: TEXT,
        trackIdentifier: 'b',
        currentIndex: 1,
        positionMs: 42_000,
        savedAt: NOW,
      },
    ]);
  });

  it.each([
    ['paused', { paused: true }],
    ['stopped', { isPlaying: false }],
    ['finished', { isPlaying: false, currentIdentifier: null }],
  ] as const)('forgets a room once it is %s', async (_state, overrides) => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    const tracker = new ResumeTracker(store, () => NOW);

    await tracker.sync(view());
    await tracker.sync(view(overrides));

    expect(await store.loadAll()).toEqual([]);
  });

  it('forgets a room the bot deliberately left', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    const tracker = new ResumeTracker(store, () => NOW);

    await tracker.sync(view());
    await tracker.forget(GUILD, ROOM);

    expect(await store.loadAll()).toEqual([]);
  });

  it('checkpoints every room it is given', async () => {
    const fleet = fakeFleet();
    const store = fleet.storeFor('main');
    const tracker = new ResumeTracker(store, () => NOW);

    await tracker.checkpoint([view(), view({ voiceChannelId: OTHER_ROOM, paused: true })]);

    expect((await store.loadAll()).map((saved) => saved.voiceChannelId)).toEqual([ROOM]);
  });

  describe('graceful shutdown', () => {
    it('keeps "was playing" and the position through the teardown that follows', async () => {
      const fleet = fakeFleet();
      const store = fleet.storeFor('main');
      let now = NOW;
      const tracker = new ResumeTracker(store, () => now);
      await tracker.sync(view({ positionMs: 10_000 }));

      now = NOW + 60_000;
      await tracker.beginShutdown([view({ positionMs: 70_000 })]);

      // The teardown: the player is destroyed (reported as not playing) and
      // the bot leaves the channel. Neither is the room ending.
      await tracker.sync(view({ isPlaying: false, positionMs: 0 }));
      await tracker.sync(view({ paused: true }));
      await tracker.forget(GUILD, ROOM);

      expect(tracker.shuttingDown).toBe(true);
      expect(await store.loadAll()).toEqual([
        expect.objectContaining({
          positionMs: 70_000,
          savedAt: NOW + 60_000,
          trackIdentifier: 'b',
        }),
      ]);
    });

    it('does not record a room that was paused when the shutdown began', async () => {
      const fleet = fakeFleet();
      const store = fleet.storeFor('main');
      const tracker = new ResumeTracker(store, () => NOW);
      await tracker.sync(view());

      await tracker.beginShutdown([view({ paused: true })]);

      expect(await store.loadAll()).toEqual([]);
    });

    it('never throws when the store fails', async () => {
      const fleet = fakeFleet();
      const store = fleet.storeFor('main');
      vi.mocked(store.save).mockRejectedValue(new Error('redis down'));
      const tracker = new ResumeTracker(store, () => NOW);

      await expect(tracker.sync(view())).resolves.toBeUndefined();
      await expect(tracker.beginShutdown([view()])).resolves.toBeUndefined();
    });
  });
});

/* ------------------------------------------------------- the Redis store */

describe('RedisResumeStore call shape', () => {
  function fakeRedis() {
    return {
      hset: vi.fn(() => Promise.resolve(1)),
      hdel: vi.fn(() => Promise.resolve(1)),
      hgetall: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
      hget: vi.fn((_key: string, _field: string): Promise<string | null> => Promise.resolve(null)),
      expire: vi.fn(() => Promise.resolve(1)),
      del: vi.fn(() => Promise.resolve(1)),
      smembers: vi.fn((): Promise<string[]> => Promise.resolve([])),
      eval: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(1)),
    };
  }

  function storeWith(redis: ReturnType<typeof fakeRedis> | undefined, botId = 'player-3') {
    return new RedisResumeStore({
      redis: () => redis as never,
      botId,
    });
  }

  it('keeps one hash per bot, one field per room, refreshed on every write', async () => {
    const redis = fakeRedis();
    await storeWith(redis).save(record());

    expect(redis.hset).toHaveBeenCalledWith(
      resumeRecordsKey('player-3'),
      roomKey(GUILD, ROOM),
      JSON.stringify(record()),
    );
    expect(redis.expire).toHaveBeenCalledWith(
      resumeRecordsKey('player-3'),
      RESUME_RECORD_TTL_SECONDS,
    );
  });

  it('removes one room', async () => {
    const redis = fakeRedis();
    await storeWith(redis).remove(GUILD, ROOM);
    expect(redis.hdel).toHaveBeenCalledWith(resumeRecordsKey('player-3'), roomKey(GUILD, ROOM));
  });

  it('reads back its own records and ignores anything malformed', async () => {
    const redis = fakeRedis();
    redis.hgetall.mockResolvedValueOnce({
      [roomKey(GUILD, ROOM)]: JSON.stringify(record()),
      broken: '{not json',
      partial: JSON.stringify({ guildId: GUILD }),
    });

    expect(await storeWith(redis).loadAll()).toEqual([record()]);
    expect(redis.hgetall).toHaveBeenCalledWith(resumeRecordsKey('player-3'));
  });

  it('claims a room through the script, with the router’s keys and lifetime', async () => {
    const redis = fakeRedis();
    const won = await storeWith(redis).claim(GUILD, ROOM, { respectOwner: true });

    expect(won).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      CLAIM_ROOM_FOR_RESUME_SCRIPT,
      3,
      roomClaimKey(GUILD, ROOM),
      botClaimKey('player-3'),
      playerRoomOwnerKey(GUILD, ROOM),
      'player-3',
      ROOM,
      String(CLAIM_TTL_MS),
      '1',
    );
  });

  it('reports a lost claim', async () => {
    const redis = fakeRedis();
    redis.eval.mockResolvedValueOnce(0);
    expect(await storeWith(redis).claim(GUILD, ROOM, { respectOwner: false })).toBe(false);
    expect(redis.eval.mock.calls[0]?.at(-1)).toBe('0');
  });

  it('treats a claim Redis could not answer as lost', async () => {
    // Joining a channel on a guess is exactly how two bots end up in it.
    const redis = fakeRedis();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    expect(await storeWith(redis).claim(GUILD, ROOM, { respectOwner: true })).toBe(false);
  });

  it('releases both halves of the claim', async () => {
    const redis = fakeRedis();
    await storeWith(redis).release(GUILD, ROOM);
    expect(redis.del).toHaveBeenCalledWith(botClaimKey('player-3'));
    expect(redis.del).toHaveBeenCalledWith(roomClaimKey(GUILD, ROOM));
  });

  it('finds a fresh record for the room held by another bot', async () => {
    const redis = fakeRedis();
    redis.smembers.mockResolvedValueOnce(['main', 'player-3', 'player-4']);
    redis.hget.mockImplementation((key: string) =>
      Promise.resolve(key === resumeRecordsKey('player-4') ? JSON.stringify(record()) : null),
    );

    expect(await storeWith(redis, 'main').heldElsewhere(GUILD, ROOM, NOW)).toBe('player-4');
    expect(redis.smembers).toHaveBeenCalledWith(playerBotIndexKey());
    // Never asks about itself.
    expect(redis.hget).not.toHaveBeenCalledWith(resumeRecordsKey('main'), expect.anything());
  });

  it('ignores another bot’s stale record', async () => {
    const redis = fakeRedis();
    redis.smembers.mockResolvedValueOnce(['player-4']);
    redis.hget.mockResolvedValue(JSON.stringify(record({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 })));
    expect(await storeWith(redis, 'main').heldElsewhere(GUILD, ROOM, NOW)).toBeUndefined();
  });

  it('degrades to "nothing saved" without Redis', async () => {
    const store = storeWith(undefined);
    await expect(store.save(record())).resolves.toBeUndefined();
    await expect(store.loadAll()).resolves.toEqual([]);
    await expect(store.heldElsewhere(GUILD, ROOM, NOW)).resolves.toBeUndefined();
  });
});

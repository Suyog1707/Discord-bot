// @vitest-environment node
/**
 * The hand-over, in two halves.
 *
 * Moved here from apps/web when the primary bot started routing commands it
 * receives over its own gateway: two processes putting work on the same
 * queues have to do it through the same code, or the claims they make stop
 * meaning the same thing.
 *
 * The first half pins the *call* — which keys, which arguments, in which
 * order — against a fake, because that is what the move could break and it
 * runs everywhere. The second half is the thing under test proper: a Lua
 * script, and a fake Redis would only test the fake — whether `SET … NX`
 * answers false or nil inside Lua, whether a failed claim really pushes
 * nothing. So that half runs only when `HAND_OVER_TEST_REDIS_URL` points at a
 * Redis nobody minds being flushed:
 *
 *   docker run -d --rm -p 127.0.0.1:6399:6379 redis:7-alpine
 *   HAND_OVER_TEST_REDIS_URL=redis://127.0.0.1:6399 pnpm exec vitest run hand-over
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botClaimKey,
  CLAIM_TTL_MS,
  interactionQueueKey,
  INTERACTION_QUEUE_TTL_SECONDS,
  roomClaimKey,
} from '../interactions/index.js';

import { CLAIM_AND_HAND_OVER_SCRIPT, claimAndHandOver, handOver } from './hand-over.js';
import { createRedisClient, type Redis } from './index.js';

const url = process.env.HAND_OVER_TEST_REDIS_URL;

const GUILD = '111111111111111111';
const ROOM_A = '222222222222222222';
const ROOM_B = '333333333333333333';

describe('hand-over call shape', () => {
  it('sends the script with the bot claim, room claim and queue as its keys', async () => {
    const evalFn = vi.fn(() => Promise.resolve(1));
    const redis = { eval: evalFn } as unknown as Redis;

    const outcome = await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_A,
      envelope: 'envelope-1',
    });

    expect(outcome).toEqual({ kind: 'won' });
    expect(evalFn).toHaveBeenCalledWith(
      CLAIM_AND_HAND_OVER_SCRIPT,
      3,
      botClaimKey('player-2'),
      roomClaimKey(GUILD, ROOM_A),
      interactionQueueKey('player-2'),
      ROOM_A,
      String(CLAIM_TTL_MS),
      'player-2',
      'envelope-1',
      String(INTERACTION_QUEUE_TTL_SECONDS),
    );
  });

  it('reports the holder of the room when the claim is lost', async () => {
    const redis = { eval: vi.fn(() => Promise.resolve('player-3')) } as unknown as Redis;
    await expect(
      claimAndHandOver(redis, {
        botId: 'player-2',
        guildId: GUILD,
        voiceChannelId: ROOM_A,
        envelope: 'e',
      }),
    ).resolves.toEqual({ kind: 'lost', holder: 'player-3' });
  });

  it('reports no holder when the room is unclaimed but the bot is taken', async () => {
    const redis = { eval: vi.fn(() => Promise.resolve(null)) } as unknown as Redis;
    await expect(
      claimAndHandOver(redis, {
        botId: 'player-2',
        guildId: GUILD,
        voiceChannelId: ROOM_A,
        envelope: 'e',
      }),
    ).resolves.toEqual({ kind: 'lost', holder: null });
  });

  function fakeMulti(result: unknown) {
    const chain = {
      rpush: vi.fn(() => chain),
      expire: vi.fn(() => chain),
      exec: vi.fn(() => Promise.resolve(result)),
    };
    return chain;
  }

  it('pushes onto the queue and sets its expiry in one transaction', async () => {
    const chain = fakeMulti([
      [null, 1],
      [null, 1],
    ]);
    const redis = { multi: vi.fn(() => chain) } as unknown as Redis;

    await handOver(redis, 'main', 'envelope-3');

    expect(chain.rpush).toHaveBeenCalledWith(interactionQueueKey('main'), 'envelope-3');
    expect(chain.expire).toHaveBeenCalledWith(
      interactionQueueKey('main'),
      INTERACTION_QUEUE_TTL_SECONDS,
    );
  });

  it('throws when a command in the transaction failed', async () => {
    const failure = new Error('OOM');
    const redis = {
      multi: vi.fn(() =>
        fakeMulti([
          [failure, null],
          [null, 1],
        ]),
      ),
    } as unknown as Redis;

    await expect(handOver(redis, 'main', 'e')).rejects.toBe(failure);
  });

  it('throws when the transaction was discarded', async () => {
    const redis = { multi: vi.fn(() => fakeMulti(null)) } as unknown as Redis;
    await expect(handOver(redis, 'main', 'e')).rejects.toThrow(/discarded/);
  });
});

describe.runIf(url !== undefined)('hand-over against Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = createRedisClient({ url: url ?? '' });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('claims the bot and the room and queues the command, all expiring', async () => {
    const outcome = await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_A,
      envelope: 'envelope-1',
    });

    expect(outcome).toEqual({ kind: 'won' });
    expect(await redis.get(botClaimKey('player-2'))).toBe(ROOM_A);
    expect(await redis.get(roomClaimKey(GUILD, ROOM_A))).toBe('player-2');
    expect(await redis.lrange(interactionQueueKey('player-2'), 0, -1)).toEqual(['envelope-1']);
    expect(await redis.pttl(botClaimKey('player-2'))).toBeGreaterThan(0);
    expect(await redis.pttl(roomClaimKey(GUILD, ROOM_A))).toBeGreaterThan(0);
    expect(await redis.ttl(interactionQueueKey('player-2'))).toBeGreaterThan(0);
  });

  it('follows whoever already holds the room, and pushes nothing itself', async () => {
    // Two /plays in one channel, a moment apart: the second must go where the
    // first went rather than being queued a second time.
    await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_A,
      envelope: 'envelope-1',
    });

    const second = await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_A,
      envelope: 'envelope-2',
    });

    expect(second).toEqual({ kind: 'lost', holder: 'player-2' });
    expect(await redis.lrange(interactionQueueKey('player-2'), 0, -1)).toEqual(['envelope-1']);
  });

  it('answers no holder when the bot was promised a different room', async () => {
    await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_A,
      envelope: 'envelope-1',
    });

    const elsewhere = await claimAndHandOver(redis, {
      botId: 'player-2',
      guildId: GUILD,
      voiceChannelId: ROOM_B,
      envelope: 'envelope-2',
    });

    expect(elsewhere).toEqual({ kind: 'lost', holder: null });
    expect(await redis.get(roomClaimKey(GUILD, ROOM_B))).toBeNull();
  });

  it('queues a command with no claim, with an expiry', async () => {
    await handOver(redis, 'main', 'envelope-3');

    expect(await redis.lrange(interactionQueueKey('main'), 0, -1)).toEqual(['envelope-3']);
    expect(await redis.ttl(interactionQueueKey('main'))).toBeGreaterThan(0);
  });
});

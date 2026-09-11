// @vitest-environment node
/**
 * The hand-over, against a real Redis.
 *
 * The thing under test is a Lua script, and a fake Redis would only test the
 * fake — whether `SET … NX` answers false or nil inside Lua, whether a failed
 * claim really pushes nothing. So this runs only when
 * `HAND_OVER_TEST_REDIS_URL` points at a Redis nobody minds being flushed:
 *
 *   docker run -d --rm -p 127.0.0.1:6399:6379 redis:7-alpine
 *   HAND_OVER_TEST_REDIS_URL=redis://127.0.0.1:6399 pnpm exec vitest run hand-over
 */
import { botClaimKey, interactionQueueKey, roomClaimKey } from '@discord-music/shared';
import { createRedisClient, type Redis } from '@discord-music/shared/redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { claimAndHandOver, handOver } from './hand-over';

const url = process.env.HAND_OVER_TEST_REDIS_URL;

const GUILD = '111111111111111111';
const ROOM_A = '222222222222222222';
const ROOM_B = '333333333333333333';

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

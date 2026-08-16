import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CooldownManager } from './cooldown.js';

describe('CooldownManager (in-memory fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first use and blocks a rapid second use', async () => {
    const cooldowns = new CooldownManager(undefined);

    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });

    const second = await cooldowns.consume('play', 'user1', 5);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(5);
  });

  it('allows again after the window expires', async () => {
    const cooldowns = new CooldownManager(undefined);
    await cooldowns.consume('play', 'user1', 5);

    vi.advanceTimersByTime(5_100);

    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toMatchObject({ allowed: true });
  });

  it('scopes cooldowns per user and per command', async () => {
    const cooldowns = new CooldownManager(undefined);
    await cooldowns.consume('play', 'user1', 5);

    await expect(cooldowns.consume('play', 'user2', 5)).resolves.toMatchObject({ allowed: true });
    await expect(cooldowns.consume('skip', 'user1', 5)).resolves.toMatchObject({ allowed: true });
  });

  it('treats a zero cooldown as no-op', async () => {
    const cooldowns = new CooldownManager(undefined);
    await expect(cooldowns.consume('help', 'user1', 0)).resolves.toMatchObject({ allowed: true });
    await expect(cooldowns.consume('help', 'user1', 0)).resolves.toMatchObject({ allowed: true });
  });

  it('prunes expired entries instead of growing forever', async () => {
    const cooldowns = new CooldownManager(undefined);

    for (let index = 0; index < 100; index += 1) {
      await cooldowns.consume('play', `user${String(index)}`, 1);
    }
    // Expire everything, pass the prune interval, and trigger a prune.
    vi.advanceTimersByTime(61_000);
    await cooldowns.consume('play', 'trigger', 1);

    // Internals are private; observable proof is that old users are allowed again.
    await expect(cooldowns.consume('play', 'user0', 1)).resolves.toMatchObject({ allowed: true });
  });

  it('falls back to memory when Redis rejects', async () => {
    const failingRedis = {
      set: vi.fn().mockRejectedValue(new Error('down')),
      ttl: vi.fn(),
    };
    const cooldowns = new CooldownManager(failingRedis as never);

    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toMatchObject({ allowed: true });
    // Second call also fails over — and the memory store already has the entry.
    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toMatchObject({ allowed: false });
  });

  it('uses Redis when it answers', async () => {
    const redis = {
      set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null),
      ttl: vi.fn().mockResolvedValue(3),
    };
    const cooldowns = new CooldownManager(redis as never);

    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toMatchObject({ allowed: true });
    await expect(cooldowns.consume('play', 'user1', 5)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3,
    });
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('cooldown'), '1', 'EX', 5, 'NX');
  });

  /**
   * Cooldowns are consulted before the command replies, so a Redis that never
   * answers must not hold the interaction past Discord's acknowledgement
   * window — it has to hand over to the in-memory store instead.
   */
  it('falls back to memory when Redis exceeds its budget', async () => {
    const hangingRedis = {
      set: vi.fn(
        () =>
          new Promise(() => {
            /* never settles */
          }),
      ),
      ttl: vi.fn(),
    };
    const cooldowns = new CooldownManager(hangingRedis as never);

    const pending = cooldowns.consume('play', 'user9', 5);
    await vi.advanceTimersByTimeAsync(600);

    await expect(pending).resolves.toMatchObject({ allowed: true });
    expect(hangingRedis.set).toHaveBeenCalledTimes(1);
  });
});

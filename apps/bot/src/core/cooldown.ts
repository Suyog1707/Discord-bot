/**
 * Per-user command cooldowns.
 *
 * Redis-backed when available so cooldowns hold across restarts and future
 * shards; otherwise an in-memory map with periodic pruning. The interface is
 * identical either way, so callers never know which backend served them.
 */
import { REDIS_NAMESPACE, redisKey } from '@discord-music/shared';
import type { Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';

const logger = getLogger('cooldown');

export interface CooldownResult {
  readonly allowed: boolean;
  /** Seconds until the command may be used again. 0 when allowed. */
  readonly retryAfterSeconds: number;
}

const ALLOWED: CooldownResult = { allowed: true, retryAfterSeconds: 0 };

export class CooldownManager {
  readonly #redis: Redis | undefined;
  /** Fallback store: key → expiry epoch ms. */
  readonly #memory = new Map<string, number>();
  #lastPrune = 0;

  constructor(redis: Redis | undefined) {
    this.#redis = redis;
  }

  /**
   * Record a use and report whether it was allowed.
   *
   * Atomic in Redis (`SET NX EX`); the in-memory path is single-threaded by
   * virtue of the event loop.
   */
  async consume(commandName: string, userId: string, seconds: number): Promise<CooldownResult> {
    if (seconds <= 0) return ALLOWED;

    const key = redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'cooldown', commandName, userId);

    if (this.#redis !== undefined) {
      try {
        const set = await this.#redis.set(key, '1', 'EX', seconds, 'NX');
        if (set === 'OK') return ALLOWED;

        const ttl = await this.#redis.ttl(key);
        return { allowed: false, retryAfterSeconds: Math.max(ttl, 1) };
      } catch (error) {
        // Redis degraded mid-session: log once per incident path and fall
        // through to memory so commands keep working.
        logger.warn({ err: error }, 'Cooldown check fell back to memory');
      }
    }

    return this.#consumeInMemory(key, seconds);
  }

  #consumeInMemory(key: string, seconds: number): CooldownResult {
    const now = Date.now();
    this.#pruneExpired(now);

    const expiresAt = this.#memory.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((expiresAt - now) / 1000) };
    }

    this.#memory.set(key, now + seconds * 1000);
    return ALLOWED;
  }

  /** Drop expired entries at most once a minute so the map cannot grow unbounded. */
  #pruneExpired(now: number): void {
    if (now - this.#lastPrune < 60_000) return;
    this.#lastPrune = now;

    for (const [key, expiresAt] of this.#memory) {
      if (expiresAt <= now) this.#memory.delete(key);
    }
  }
}

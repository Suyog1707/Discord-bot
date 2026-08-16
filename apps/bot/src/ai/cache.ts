/**
 * Two-tier cache for the recommendation stack.
 *
 * Every service below this one talks to a third party over the network, and the
 * same questions get asked constantly: the similar tracks for the song that is
 * playing, the canonical name for an artist the queue is full of, the tags for a
 * genre the guild always listens to. Without a cache a single autoplay pick
 * costs a dozen round trips to Last.fm.
 *
 * Redis is the shared tier so every shard and every restart reuses the same
 * answers. The in-memory tier sits in front of it: it absorbs the within-request
 * repeats (a 300-track queue asks for the same artist over and over) and, more
 * importantly, it is what the whole stack falls back to when Redis is missing or
 * unreachable. A cache is an optimisation — losing it must never take music with
 * it, so every Redis error here is swallowed and demoted to a memory hit.
 */
import type { Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';

const logger = getLogger('ai-cache');

/** Namespaced so a shared Redis instance cannot collide with cooldowns or pub/sub. */
const KEY_PREFIX = 'ai:cache:';

/**
 * Bounded so a long-running bot cannot leak. Entries are small (a few hundred
 * bytes of JSON), so this is well under a megabyte in practice.
 */
const MEMORY_MAX_ENTRIES = 5_000;

interface MemoryEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly memoryEntries: number;
  /** Redis reads that threw. A non-zero count means the shared tier is degraded. */
  readonly redisErrors: number;
}

export class CacheService {
  readonly #redis: Redis | undefined;
  readonly #memory = new Map<string, MemoryEntry>();

  #hits = 0;
  #misses = 0;
  #redisErrors = 0;

  /**
   * @param redis - Shared connection, or undefined to run memory-only. Passing
   *   undefined is a supported mode, not a degraded one: a single-process bot
   *   with no Redis still gets the full benefit of the in-memory tier.
   */
  constructor(redis?: Redis) {
    this.#redis = redis;
  }

  get stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      memoryEntries: this.#memory.size,
      redisErrors: this.#redisErrors,
    };
  }

  async get<T>(key: string): Promise<T | null> {
    const local = this.#memory.get(key);
    if (local !== undefined) {
      if (local.expiresAt > Date.now()) {
        this.#hits += 1;
        return local.value as T;
      }
      this.#memory.delete(key);
    }

    if (this.#redis === undefined) {
      this.#misses += 1;
      return null;
    }

    try {
      const raw = await this.#redis.get(KEY_PREFIX + key);
      if (raw === null) {
        this.#misses += 1;
        return null;
      }
      const value = JSON.parse(raw) as T;
      // Promote into memory so the next read in this process skips the network.
      // The remaining Redis TTL is unknown here; a short local window is safe
      // because Redis stays authoritative once it expires.
      this.#remember(key, value, 60_000);
      this.#hits += 1;
      return value;
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, key }, 'Cache read failed; falling back to miss');
      this.#misses += 1;
      return null;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.#remember(key, value, ttlMs);
    if (this.#redis === undefined) return;

    try {
      await this.#redis.set(KEY_PREFIX + key, JSON.stringify(value), 'PX', ttlMs);
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, key }, 'Cache write failed; memory tier still holds the value');
    }
  }

  /**
   * Read-through: return the cached value, or compute it, store it and return.
   *
   * `compute` returning null is cached as a negative result for a tenth of the
   * TTL. Without that, a track Last.fm has never heard of re-asks on every
   * single autoplay tick — the misses are exactly the queries that cost the most
   * because they run to the timeout.
   */
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T | null>): Promise<T | null> {
    const cached = await this.get<{ readonly v: T | null }>(key);
    if (cached !== null) return cached.v;

    const value = await compute();
    await this.set(key, { v: value }, value === null ? Math.max(30_000, ttlMs / 10) : ttlMs);
    return value;
  }

  #remember(key: string, value: unknown, ttlMs: number): void {
    if (this.#memory.size >= MEMORY_MAX_ENTRIES) {
      // Map iterates in insertion order, so the first key is the oldest write.
      const oldest = this.#memory.keys().next();
      if (oldest.done !== true) this.#memory.delete(oldest.value);
    }
    this.#memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

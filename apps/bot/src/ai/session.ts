/**
 * Per-guild autoplay session state.
 *
 * Autoplay repeating a song is a state problem, not a ranking problem: nothing
 * separates a track that already PLAYED from one merely QUEUED, or from one a
 * concurrent recommendation pass has just PICKED but not yet queued. Two
 * autoplay ticks racing each other — the buffer refill in `autoplay.ts` and a
 * synchronous top-up on the same guild — can both run candidate generation at
 * once and, without something in between "picked" and "queued", both land on
 * the same song. `reserve()` is that something: a short-lived claim a caller
 * takes out on a track key before it commits to queuing it.
 *
 * The store follows the two-tier shape from `cache.ts`: the in-memory mirror
 * is written on every call and is what the whole stack falls back to, Redis is
 * the shared, restart-surviving tier layered on top, and every Redis error is
 * swallowed and counted rather than allowed to take autoplay down with it. The
 * one place that inverts cache.ts's memory-first read order is `snapshot()`:
 * it prefers a successful Redis read over memory, because after a bot restart
 * memory starts empty while Redis still remembers the session.
 */
import type { Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';

const logger = getLogger('ai-session');

const SESSION_PREFIX = 'autoplay:sess:';
const RESERVATION_PREFIX = 'autoplay:resv:';

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_RESERVATION_TTL_SECONDS = 10 * 60;

/** Bounded so a long-running, many-guild bot cannot leak memory. */
const MAX_GUILD_SESSIONS = 500;

/** Half-life-shaped decay: how many "recent plays back" still counts as fatigue. */
const FATIGUE_TAU = 6;

export interface SessionEntry {
  readonly key: string; // canonical track key
  readonly identifier: string; // provider video id ('' when unknown)
  readonly artistKey: string; // canonical artist key
}

export interface SessionOutcomes {
  readonly recommended: number;
  readonly played: number;
  readonly completed: number;
  readonly skipped: number;
  /** Post-filter duplicates caught — the rate that must stay ~0. */
  readonly duplicatesBlocked: number;
}

export interface SessionSnapshot {
  /** Canonical keys of tracks that actually played, newest first. */
  readonly recentKeys: readonly string[];
  readonly recentIdentifiers: readonly string[];
  /** Artist keys of recent plays, newest first, repeats preserved. */
  readonly recentArtists: readonly string[];
  readonly queuedKeys: ReadonlySet<string>;
  readonly queuedIdentifiers: ReadonlySet<string>;
  readonly reservedKeys: ReadonlySet<string>;
  /** artistKey -> fatigue 0..1 (1 = just played repeatedly). */
  readonly artistFatigue: ReadonlyMap<string, number>;
  readonly outcomes: SessionOutcomes;
}

export interface SessionStoreOptions {
  readonly redis?: Redis;
  /** Played-history ring size. Default 50. */
  readonly recentLimit?: number;
  /** Session expiry. Default 6h. */
  readonly ttlSeconds?: number;
  /** Reservation expiry. Default 10 minutes. */
  readonly reservationTtlSeconds?: number;
  /**
   * Clock override for tests. Reservation and session TTLs are evaluated
   * against this instead of `Date.now()`, which makes expiry deterministic
   * without `vi.useFakeTimers()` fighting the store's own async Redis calls.
   */
  readonly now?: () => number;
}

interface GuildSession {
  recent: SessionEntry[];
  queued: SessionEntry[];
  /** trackKey -> expiry timestamp (ms), pruned lazily. */
  reservations: Map<string, number>;
  outcomes: SessionOutcomes;
  /** Last time any operation touched this guild — drives both TTL pruning and LRU eviction. */
  touchedAt: number;
}

function emptyOutcomes(): SessionOutcomes {
  return { recommended: 0, played: 0, completed: 0, skipped: 0, duplicatesBlocked: 0 };
}

function recentKey(guildId: string): string {
  return `${SESSION_PREFIX}${guildId}:recent`;
}

function queuedKey(guildId: string): string {
  return `${SESSION_PREFIX}${guildId}:queued`;
}

function outcomesKey(guildId: string): string {
  return `${SESSION_PREFIX}${guildId}:outcomes`;
}

function reservationKey(guildId: string, trackKey: string): string {
  return `${RESERVATION_PREFIX}${guildId}:${trackKey}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Pure, exported for tests and for sequence simulation in ranking.
 *
 * fatigue = clamp01( sum over occurrences of exp(-index / tau) ), tau = 6.
 * index 0 = just played. A single recent play starts at 1.0 and decays; a
 * repeat within the window compounds on top of it, which is what makes "twice
 * recently" outrank "once, ten tracks ago" (≈0.19) even though both are a
 * single occurrence away from a clamp ceiling.
 */
export function computeArtistFatigue(recentArtists: readonly string[]): ReadonlyMap<string, number> {
  const fatigue = new Map<string, number>();
  recentArtists.forEach((artist, index) => {
    const contribution = Math.exp(-index / FATIGUE_TAU);
    fatigue.set(artist, (fatigue.get(artist) ?? 0) + contribution);
  });
  for (const [artist, value] of fatigue) fatigue.set(artist, clamp01(value));
  return fatigue;
}

function parseOutcomes(raw: Record<string, string>): SessionOutcomes {
  const field = (name: keyof SessionOutcomes): number => {
    const value = raw[name];
    const parsed = value === undefined ? 0 : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    recommended: field('recommended'),
    played: field('played'),
    completed: field('completed'),
    skipped: field('skipped'),
    duplicatesBlocked: field('duplicatesBlocked'),
  };
}

export class AutoplaySessionStore {
  readonly #redis: Redis | undefined;
  readonly #recentLimit: number;
  readonly #ttlSeconds: number;
  readonly #reservationTtlSeconds: number;
  readonly #now: () => number;

  readonly #sessions = new Map<string, GuildSession>();

  #redisErrors = 0;

  constructor(options: SessionStoreOptions = {}) {
    this.#redis = options.redis;
    this.#recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#reservationTtlSeconds = options.reservationTtlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;
    this.#now = options.now ?? Date.now;
  }

  /** Redis errors swallowed so far (for /aistatus + tests). */
  get redisErrors(): number {
    return this.#redisErrors;
  }

  async snapshot(guildId: string): Promise<SessionSnapshot> {
    const session = this.#touch(guildId);

    const recent = await this.#readRecent(guildId, session);
    const queued = await this.#readQueued(guildId, session);
    const outcomes = await this.#readOutcomes(guildId, session);

    const identifiers = new Set<string>();
    for (const entry of queued) {
      if (entry.identifier !== '') identifiers.add(entry.identifier);
    }

    return {
      recentKeys: recent.map((entry) => entry.key),
      recentIdentifiers: recent.map((entry) => entry.identifier),
      recentArtists: recent.map((entry) => entry.artistKey),
      queuedKeys: new Set(queued.map((entry) => entry.key)),
      queuedIdentifiers: identifiers,
      reservedKeys: new Set(session.reservations.keys()),
      artistFatigue: computeArtistFatigue(recent.map((entry) => entry.artistKey)),
      outcomes,
    };
  }

  /**
   * Atomically reserve keys; returns ONLY the keys this caller won.
   *
   * Two passes. The first is a synchronous check-and-set against the memory
   * mirror with no `await` inside it: `Promise.all([reserve(a), reserve(b)])`
   * runs each call's body synchronously up to its first `await`, and because
   * JS never preempts synchronous code, a whole loop with no `await` in it is
   * as atomic as a lock without needing one — the second caller can only ever
   * observe the first caller's completed writes, never an interleaving of
   * them. That handles same-process races for free.
   *
   * The second pass asks Redis's `SET NX` to arbitrate across processes, which
   * a same-process Map can never do. Any memory grant Redis did not confirm is
   * handed back; a Redis failure just means the memory decision stands, since
   * a single process degraded to memory-only reservations is still correct —
   * only cross-process correctness was lost, and that loss was there anyway.
   */
  async reserve(guildId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
    const session = this.#touch(guildId);
    const now = this.#now();

    const granted = new Set<string>();
    for (const key of new Set(keys)) {
      const expiresAt = session.reservations.get(key);
      if (expiresAt !== undefined && expiresAt > now) continue;
      session.reservations.set(key, now + this.#reservationTtlSeconds * 1000);
      granted.add(key);
    }

    if (this.#redis === undefined || granted.size === 0) return granted;

    try {
      const redis = this.#redis;
      const outcomes = await Promise.all(
        [...granted].map(async (key) => {
          const result = await redis.set(
            reservationKey(guildId, key),
            '1',
            'EX',
            this.#reservationTtlSeconds,
            'NX',
          );
          return [key, result === 'OK'] as const;
        }),
      );
      for (const [key, won] of outcomes) {
        if (!won) {
          granted.delete(key);
          session.reservations.delete(key);
        }
      }
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reservation sync to Redis failed; memory grant stands');
    }

    return granted;
  }

  async release(guildId: string, keys: readonly string[]): Promise<void> {
    const session = this.#touch(guildId);
    for (const key of keys) session.reservations.delete(key);

    if (this.#redis === undefined || keys.length === 0) return;

    try {
      await this.#redis.del(...keys.map((key) => reservationKey(guildId, key)));
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reservation release in Redis failed; memory already cleared');
    }
  }

  /** Authoritative replace of the queued set from the live queue. */
  async syncQueue(guildId: string, entries: readonly SessionEntry[]): Promise<void> {
    const session = this.#touch(guildId);
    session.queued = [...entries];

    if (this.#redis === undefined) return;

    try {
      await this.#redis.set(queuedKey(guildId), JSON.stringify(session.queued), 'EX', this.#ttlSeconds);
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Queue sync to Redis failed; memory tier still holds it');
    }
  }

  /** A track started playing: push to recent ring, drop from queued+reserved. */
  async recordPlayed(guildId: string, entry: SessionEntry): Promise<void> {
    const session = this.#touch(guildId);
    session.recent = [entry, ...session.recent].slice(0, this.#recentLimit);
    session.queued = session.queued.filter((queuedEntry) => queuedEntry.key !== entry.key);
    session.reservations.delete(entry.key);

    if (this.#redis === undefined) return;

    try {
      const pipeline = this.#redis.multi();
      pipeline.lpush(recentKey(guildId), JSON.stringify(entry));
      pipeline.ltrim(recentKey(guildId), 0, this.#recentLimit - 1);
      pipeline.expire(recentKey(guildId), this.#ttlSeconds);
      pipeline.del(reservationKey(guildId, entry.key));
      await pipeline.exec();
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Recording played track in Redis failed; memory tier still holds it');
    }
  }

  async recordOutcome(guildId: string, outcome: keyof SessionOutcomes, count = 1): Promise<void> {
    const session = this.#touch(guildId);
    session.outcomes = { ...session.outcomes, [outcome]: session.outcomes[outcome] + count };

    if (this.#redis === undefined) return;

    try {
      const pipeline = this.#redis.multi();
      pipeline.hincrby(outcomesKey(guildId), outcome, count);
      pipeline.expire(outcomesKey(guildId), this.#ttlSeconds);
      await pipeline.exec();
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Recording outcome in Redis failed; memory tier still holds it');
    }
  }

  async clear(guildId: string): Promise<void> {
    this.#sessions.delete(guildId);

    if (this.#redis === undefined) return;

    try {
      // Reservation keys are not tracked here — they are short-lived (10 min
      // default) and self-expire, and clearing a guild that just finished a
      // session is not on a path where a stale reservation matters.
      await this.#redis.del(recentKey(guildId), queuedKey(guildId), outcomesKey(guildId));
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Clearing session in Redis failed; memory tier already cleared');
    }
  }

  async #readRecent(guildId: string, session: GuildSession): Promise<readonly SessionEntry[]> {
    if (this.#redis === undefined) return session.recent;

    try {
      const raw = await this.#redis.lrange(recentKey(guildId), 0, this.#recentLimit - 1);
      const entries = raw.map((item) => JSON.parse(item) as SessionEntry);
      session.recent = entries;
      return entries;
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reading recent tracks from Redis failed; using memory');
      return session.recent;
    }
  }

  async #readQueued(guildId: string, session: GuildSession): Promise<readonly SessionEntry[]> {
    if (this.#redis === undefined) return session.queued;

    try {
      const raw = await this.#redis.get(queuedKey(guildId));
      if (raw === null) return session.queued;
      const entries = JSON.parse(raw) as SessionEntry[];
      session.queued = entries;
      return entries;
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reading queued tracks from Redis failed; using memory');
      return session.queued;
    }
  }

  async #readOutcomes(guildId: string, session: GuildSession): Promise<SessionOutcomes> {
    if (this.#redis === undefined) return session.outcomes;

    try {
      const raw = await this.#redis.hgetall(outcomesKey(guildId));
      if (Object.keys(raw).length === 0) return session.outcomes;
      const outcomes = parseOutcomes(raw);
      session.outcomes = outcomes;
      return outcomes;
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reading outcomes from Redis failed; using memory');
      return session.outcomes;
    }
  }

  /**
   * Fetch-or-create a guild's memory session, mark it as just touched, and run
   * the two lazy sweeps that keep memory bounded: expired reservations within
   * this session, and — because re-touching always re-inserts into `#sessions`
   * — stale or excess guilds at the front of the map, which is the
   * least-recently-touched end.
   */
  #touch(guildId: string): GuildSession {
    const now = this.#now();

    let session = this.#sessions.get(guildId);
    if (session === undefined) {
      session = { recent: [], queued: [], reservations: new Map(), outcomes: emptyOutcomes(), touchedAt: now };
    } else {
      this.#sessions.delete(guildId);
    }
    session.touchedAt = now;
    this.#sessions.set(guildId, session);

    for (const [key, expiresAt] of session.reservations) {
      if (expiresAt <= now) session.reservations.delete(key);
    }

    const cutoff = now - this.#ttlSeconds * 1000;
    for (const [otherGuildId, otherSession] of this.#sessions) {
      if (otherGuildId === guildId || otherSession.touchedAt >= cutoff) break;
      this.#sessions.delete(otherGuildId);
    }

    while (this.#sessions.size > MAX_GUILD_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true || oldest.value === guildId) break;
      this.#sessions.delete(oldest.value);
    }

    return session;
  }
}

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

import type { AutoplayKind } from './interleave.js';

const logger = getLogger('ai-session');

const SESSION_PREFIX = 'autoplay:sess:';
const RESERVATION_PREFIX = 'autoplay:resv:';

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
/**
 * MUST outlive the autoplay buffer TTL (15 min in autoplay.ts): a buffered but
 * not-yet-served pick is protected by its reservation and nothing else — it is
 * neither queued nor recently played — so a reservation that lapses before the
 * buffer does leaves a window where a refill can pick the same song twice.
 */
const DEFAULT_RESERVATION_TTL_SECONDS = 20 * 60;

/** Bounded so a long-running, many-guild bot cannot leak memory. */
const MAX_GUILD_SESSIONS = 500;
/** Session dislikes kept per guild; the durable record has no such cap. */
const MAX_SESSION_DISLIKES = 500;

/** Half-life-shaped decay: how many "recent plays back" still counts as fatigue. */
const FATIGUE_TAU = 6;

/**
 * How many listeners the snapshot reports. Personalisation blends a profile per
 * listener, and past a handful the blend is indistinguishable from the guild's
 * own taste while the query cost keeps climbing.
 */
const MAX_LISTENERS = 5;

/**
 * Requester ids that identify nobody: `''` is "unknown", `'0'` is what a
 * restored queue and the autoplay requester itself carry. Treating either as a
 * listener would personalise the room around a placeholder.
 */
const ANONYMOUS_REQUESTERS: ReadonlySet<string> = new Set(['', '0']);

export interface SessionEntry {
  readonly key: string; // canonical track key
  readonly identifier: string; // provider video id ('' when unknown)
  readonly artistKey: string; // canonical artist key
  /**
   * The same song's key in the OTHER vocabulary, when known. A recommended
   * track has two spellings: the Last.fm candidate it was picked as and the
   * YouTube upload it resolved to. Exclusion sets must hold both, or the next
   * generation pass — which filters Last.fm-vocabulary candidates — never
   * matches the YouTube-vocabulary key the queue recorded.
   */
  readonly altKey?: string;
  /**
   * How the track entered the queue. Absent on entries written before this
   * field existed (and by any caller that does not care), which is why every
   * consumer below treats "no origin" as "not a signal" rather than as 'user'.
   */
  readonly origin?: 'user' | 'autoplay';
  /**
   * Which half of the autoplay cadence this pick filled. Only autoplay entries
   * carry it, and it is the ONLY record of the familiar/discovery rhythm that
   * survives a batch boundary — the planner generates two tracks at a time and
   * would otherwise restart its run counter every second song.
   */
  readonly kind?: AutoplayKind;
  /**
   * Discord id of whoever asked for this track. Autoplay is personalised
   * around the people currently in the room, and the queue is the only place
   * that knows who they are — `SongHistory.userId` is null for anyone who has
   * never touched favourites or playlists.
   */
  readonly requestedById?: string;
  /**
   * When the track started, epoch ms. Stamped by `recordPlayed`. This is
   * what turns the recent ring from a permanent ban into a cooldown: a song
   * from three hours ago may come back, one from ten minutes ago may not,
   * and without a clock the two are indistinguishable.
   */
  readonly playedAt?: number;
}

/** Both keys an entry is known under. */
function keysOf(entry: SessionEntry): readonly string[] {
  return entry.altKey === undefined || entry.altKey === entry.key
    ? [entry.key]
    : [entry.key, entry.altKey];
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
  /**
   * The recent ring itself, newest first, timestamps included. The planner
   * applies its repeat cooldown to this — by position and by age — rather
   * than treating every key in `recentKeys` as excluded forever.
   */
  readonly recentEntries: readonly SessionEntry[];
  /**
   * Canonical keys the room has explicitly disliked this session. Mirrors
   * the persistent store so a dislike takes effect on the very next
   * generation pass, before any database read.
   */
  readonly dislikedKeys: ReadonlySet<string>;
  readonly queuedKeys: ReadonlySet<string>;
  readonly queuedIdentifiers: ReadonlySet<string>;
  readonly reservedKeys: ReadonlySet<string>;
  /** artistKey -> fatigue 0..1 (1 = just played repeatedly). */
  readonly artistFatigue: ReadonlyMap<string, number>;
  /**
   * The familiar/discovery rhythm as the listener will experience it, newest
   * first — which is NOT the order the entries are stored in. Queued autoplay
   * picks come first, reversed, because the last one queued is the furthest
   * from the speaker and therefore the most recent decision the planner made;
   * recent plays follow, already newest-first. Reading them in this order is
   * what lets a run of familiars continue across generation batches instead of
   * resetting every two tracks.
   */
  readonly recentAutoplayKinds: readonly AutoplayKind[];
  /**
   * Distinct Discord ids of the people whose requests are in this session,
   * most recently heard first, capped at {@link MAX_LISTENERS}. This is the
   * answer to "who is this radio for" — without it, personalisation has only
   * the guild's aggregate taste to work from.
   */
  readonly listenerIds: readonly string[];
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
  /** Canonical keys disliked this session. Persisted separately in the DB. */
  disliked: Set<string>;
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

function dislikedKey(guildId: string): string {
  return `${SESSION_PREFIX}${guildId}:disliked`;
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
export function computeArtistFatigue(
  recentArtists: readonly string[],
): ReadonlyMap<string, number> {
  const fatigue = new Map<string, number>();
  recentArtists.forEach((artist, index) => {
    const contribution = Math.exp(-index / FATIGUE_TAU);
    fatigue.set(artist, (fatigue.get(artist) ?? 0) + contribution);
  });
  for (const [artist, value] of fatigue) fatigue.set(artist, clamp01(value));
  return fatigue;
}

/**
 * The autoplay cadence, newest decision first.
 *
 * `queued` is in play order, so the pick made LAST sits at the end of it — the
 * reverse of what "newest first" means. Recent plays are already newest first
 * and simply follow. Entries with no `kind` (user requests, and anything
 * written before the field existed) are not part of the rhythm at all.
 */
function autoplayKindsOf(
  recent: readonly SessionEntry[],
  queued: readonly SessionEntry[],
): readonly AutoplayKind[] {
  const kindOf = (entry: SessionEntry): AutoplayKind | undefined => entry.kind;
  // The playing track is BOTH the head of `recent` (it started) and the head
  // of `queued` (the queue mirror includes the current track). Counted twice
  // it would advance the cadence a beat early, so the recent ring wins and
  // any queued entry it already covers is dropped.
  const covered = new Set(recent.flatMap(keysOf));
  const queuedKinds = [...queued]
    .reverse()
    .filter((entry) => !keysOf(entry).some((key) => covered.has(key)))
    .map(kindOf);
  return [...queuedKinds, ...recent.map(kindOf)].filter(
    (kind): kind is AutoplayKind => kind !== undefined,
  );
}

/**
 * Who this session belongs to: the requesters of user-origin entries, most
 * recently heard first. Recent plays lead because someone who just heard their
 * request is more certainly still listening than someone whose track is still
 * waiting in the queue — though both count.
 */
function listenersOf(
  recent: readonly SessionEntry[],
  queued: readonly SessionEntry[],
): readonly string[] {
  const listeners: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...recent, ...queued]) {
    const id = entry.requestedById;
    if (entry.origin !== 'user' || id === undefined) continue;
    if (ANONYMOUS_REQUESTERS.has(id) || seen.has(id)) continue;
    seen.add(id);
    listeners.push(id);
    if (listeners.length >= MAX_LISTENERS) break;
  }
  return listeners;
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
      // Both vocabularies of every entry: exclusion consumers put these in
      // Sets, so the flattening does not disturb any ordering they rely on.
      recentKeys: recent.flatMap(keysOf),
      recentIdentifiers: recent.map((entry) => entry.identifier),
      recentArtists: recent.map((entry) => entry.artistKey),
      queuedKeys: new Set(queued.flatMap(keysOf)),
      queuedIdentifiers: identifiers,
      reservedKeys: new Set(session.reservations.keys()),
      artistFatigue: computeArtistFatigue(recent.map((entry) => entry.artistKey)),
      recentEntries: recent,
      dislikedKeys: await this.#readDisliked(guildId, session),
      recentAutoplayKinds: autoplayKindsOf(recent, queued),
      listenerIds: listenersOf(recent, queued),
      outcomes,
    };
  }

  /**
   * Note an explicit dislike for this guild's session.
   *
   * The durable record lives in the database; this mirror exists so the
   * exclusion applies on the very next generation pass and so a buffered
   * pick for the same song is recognised without a query. Reservations on
   * the keys are dropped too: nothing should be holding a disliked song.
   */
  async recordDisliked(guildId: string, keys: readonly string[]): Promise<void> {
    const session = this.#touch(guildId);
    // Guild-wide on purpose: the room shares one queue, so one listener's
    // "not like" keeps the song out for everyone present this session — the
    // durable per-user record is what carries it into other rooms. Bounded
    // like the recent ring; a session that dislikes hundreds of songs keeps
    // the newest.
    for (const key of keys) {
      session.disliked.add(key);
      session.reservations.delete(key);
    }
    while (session.disliked.size > MAX_SESSION_DISLIKES) {
      const oldest = session.disliked.values().next();
      if (oldest.done === true) break;
      session.disliked.delete(oldest.value);
    }

    if (this.#redis === undefined || keys.length === 0) return;

    try {
      const pipeline = this.#redis.multi();
      pipeline.sadd(dislikedKey(guildId), ...keys);
      pipeline.expire(dislikedKey(guildId), this.#ttlSeconds);
      for (const key of keys) pipeline.del(reservationKey(guildId, key));
      await pipeline.exec();
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Recording dislike in Redis failed; memory tier still holds it',
      );
    }
  }

  /** A forgiven song: `/dislike remove` must take effect this session, not after the TTL. */
  async forgetDisliked(guildId: string, keys: readonly string[]): Promise<void> {
    const session = this.#touch(guildId);
    for (const key of keys) session.disliked.delete(key);

    if (this.#redis === undefined || keys.length === 0) return;

    try {
      await this.#redis.srem(dislikedKey(guildId), ...keys);
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Forgetting dislike in Redis failed; memory already cleared',
      );
    }
  }

  async #readDisliked(guildId: string, session: GuildSession): Promise<ReadonlySet<string>> {
    if (this.#redis === undefined) return new Set(session.disliked);

    try {
      const raw = await this.#redis.smembers(dislikedKey(guildId));
      for (const key of raw) session.disliked.add(key);
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug({ err: error, guildId }, 'Reading dislikes from Redis failed; using memory');
    }
    return new Set(session.disliked);
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
      logger.debug(
        { err: error, guildId },
        'Reservation sync to Redis failed; memory grant stands',
      );
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
      logger.debug(
        { err: error, guildId },
        'Reservation release in Redis failed; memory already cleared',
      );
    }
  }

  /** Authoritative replace of the queued set from the live queue. */
  async syncQueue(guildId: string, entries: readonly SessionEntry[]): Promise<void> {
    const session = this.#touch(guildId);
    session.queued = [...entries];

    if (this.#redis === undefined) return;

    try {
      await this.#redis.set(
        queuedKey(guildId),
        JSON.stringify(session.queued),
        'EX',
        this.#ttlSeconds,
      );
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Queue sync to Redis failed; memory tier still holds it',
      );
    }
  }

  /** A track started playing: push to recent ring, drop from queued+reserved. */
  async recordPlayed(guildId: string, entry: SessionEntry): Promise<void> {
    const session = this.#touch(guildId);
    const entryKeys = new Set(keysOf(entry));
    const stamped: SessionEntry =
      entry.playedAt === undefined ? { ...entry, playedAt: this.#now() } : entry;
    session.recent = [stamped, ...session.recent].slice(0, this.#recentLimit);
    session.queued = session.queued.filter(
      (queuedEntry) => !keysOf(queuedEntry).some((key) => entryKeys.has(key)),
    );
    for (const key of entryKeys) session.reservations.delete(key);

    if (this.#redis === undefined) return;

    try {
      const pipeline = this.#redis.multi();
      pipeline.lpush(recentKey(guildId), JSON.stringify(stamped));
      pipeline.ltrim(recentKey(guildId), 0, this.#recentLimit - 1);
      pipeline.expire(recentKey(guildId), this.#ttlSeconds);
      for (const key of entryKeys) pipeline.del(reservationKey(guildId, key));
      await pipeline.exec();
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Recording played track in Redis failed; memory tier still holds it',
      );
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
      logger.debug(
        { err: error, guildId },
        'Recording outcome in Redis failed; memory tier still holds it',
      );
    }
  }

  async clear(guildId: string): Promise<void> {
    this.#sessions.delete(guildId);

    if (this.#redis === undefined) return;

    try {
      // Reservation keys are not tracked here — they are short-lived (10 min
      // default) and self-expire, and clearing a guild that just finished a
      // session is not on a path where a stale reservation matters.
      await this.#redis.del(
        recentKey(guildId),
        queuedKey(guildId),
        outcomesKey(guildId),
        dislikedKey(guildId),
      );
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Clearing session in Redis failed; memory tier already cleared',
      );
    }
  }

  async #readRecent(guildId: string, session: GuildSession): Promise<readonly SessionEntry[]> {
    if (this.#redis === undefined) return session.recent;

    try {
      const raw = await this.#redis.lrange(recentKey(guildId), 0, this.#recentLimit - 1);
      // An empty list while memory holds history means the Redis key expired
      // or a blip dropped writes — NOT that nothing played. Adopting the empty
      // read would wipe the whole anti-repeat window in one snapshot; memory
      // is more trustworthy than an absence.
      if (raw.length === 0 && session.recent.length > 0) return session.recent;
      const entries = raw.map((item) => JSON.parse(item) as SessionEntry);
      session.recent = entries;
      return entries;
    } catch (error) {
      this.#redisErrors += 1;
      logger.debug(
        { err: error, guildId },
        'Reading recent tracks from Redis failed; using memory',
      );
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
      logger.debug(
        { err: error, guildId },
        'Reading queued tracks from Redis failed; using memory',
      );
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
      session = {
        recent: [],
        queued: [],
        disliked: new Set(),
        reservations: new Map(),
        outcomes: emptyOutcomes(),
        touchedAt: now,
      };
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

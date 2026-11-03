/**
 * Picking the music back up after a restart.
 *
 * Every bot keeps a small record of the rooms it is *actively playing* in —
 * which track, how far in, and when that was last true — and on startup it
 * rejoins exactly those rooms and carries on from about where it stopped.
 *
 * Why a separate record instead of reusing what already exists: a graceful
 * shutdown tears every player down, and the teardown reports each room as
 * stopped (deleting the retained snapshot and the owner key). The queue row in
 * Postgres survives, but it has no position and no "was playing". So the
 * record is written *before* the teardown (see {@link ResumeTracker}) and kept
 * through it.
 *
 * Three pieces live here:
 *  - {@link ResumeTracker} keeps the records honest while the bot runs;
 *  - {@link decideRoomResume} / {@link restorePlayingRooms} decide which saved
 *    rooms are worth rejoining and turn each into a join;
 *  - {@link RedisResumeStore} is the Redis half, including the atomic claim
 *    that stops two bots taking one room.
 */
import {
  botClaimKey,
  CLAIM_TTL_MS,
  playerBotIndexKey,
  playerRoomOwnerKey,
  REDIS_NAMESPACE,
  redisKey,
  roomClaimKey,
} from '@discord-music/shared';
import type { Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';
import type { PersistedQueue } from './queue-store.js';

const logger = getLogger('room-resume');

/**
 * A save older than this is stale. Restarts take seconds to a couple of
 * minutes; a record from an hour ago describes a room whose listeners are long
 * gone, and starting music at nobody is worse than staying quiet. Exactly this
 * old is still fresh.
 */
export const RESUME_MAX_AGE_MS = 10 * 60_000;

/**
 * How often a playing room's position is written while the bot runs. This is
 * what a crash (as opposed to a graceful restart) resumes from, so it bounds
 * how much of a song is replayed after one.
 */
export const RESUME_CHECKPOINT_INTERVAL_MS = 15_000;

/** Lifetime of a bot's record hash, refreshed on every write. */
export const RESUME_RECORD_TTL_SECONDS = 24 * 60 * 60;

/** How long a restore waits for the audio server before giving up. */
export const RESUME_NODE_READY_TIMEOUT_MS = 60_000;

/** One hash per bot, one field per room. */
export function resumeRecordsKey(botId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'resume', botId);
}

/** What a bot remembers about a room it was playing in. */
export interface ResumeRecord {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string | null;
  readonly trackIdentifier: string;
  readonly currentIndex: number;
  readonly positionMs: number;
  /** Epoch ms of the last time the room was seen playing. */
  readonly savedAt: number;
}

export interface ResumeStore {
  readonly save: (record: ResumeRecord) => Promise<void>;
  readonly remove: (guildId: string, voiceChannelId: string) => Promise<void>;
  readonly loadAll: () => Promise<readonly ResumeRecord[]>;
  /**
   * Take the room for this bot, atomically. False when another bot holds it,
   * owns it, or this bot is already promised elsewhere.
   */
  readonly claim: (
    guildId: string,
    voiceChannelId: string,
    options: { readonly respectOwner: boolean },
  ) => Promise<boolean>;
  readonly release: (guildId: string, voiceChannelId: string) => Promise<void>;
  /** The id of another bot holding a fresh record for this room, if any. */
  readonly heldElsewhere: (
    guildId: string,
    voiceChannelId: string,
    now: number,
  ) => Promise<string | undefined>;
}

/** The slice of a player the tracker needs, so it never touches GuildPlayer. */
export interface PlayingRoomView {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string | null;
  readonly isPlaying: boolean;
  readonly paused: boolean;
  readonly currentIdentifier: string | null;
  readonly currentIndex: number;
  readonly positionMs: number;
}

export type ResumeSkipReason =
  | 'stale'
  | 'not-in-guild'
  | 'channel-gone'
  | 'no-listeners'
  | 'already-active'
  | 'empty-queue'
  | 'claimed-elsewhere';

export type ResumeDecision =
  { readonly kind: 'restore' } | { readonly kind: 'skip'; readonly reason: ResumeSkipReason };

/**
 * Whether a saved room is worth rejoining. Checked cheapest and most final
 * first, so the reason logged is the first thing that ruled the room out.
 */
export function decideRoomResume(facts: {
  readonly record: ResumeRecord;
  readonly now: number;
  readonly guildPresent: boolean;
  readonly channelIsVoice: boolean;
  readonly humanListeners: number;
  readonly hasPlayer: boolean;
}): ResumeDecision {
  if (facts.now - facts.record.savedAt > RESUME_MAX_AGE_MS)
    return { kind: 'skip', reason: 'stale' };
  if (!facts.guildPresent) return { kind: 'skip', reason: 'not-in-guild' };
  if (!facts.channelIsVoice) return { kind: 'skip', reason: 'channel-gone' };
  if (facts.humanListeners === 0) return { kind: 'skip', reason: 'no-listeners' };
  if (facts.hasPlayer) return { kind: 'skip', reason: 'already-active' };
  return { kind: 'restore' };
}

/**
 * Where to start playing.
 *
 * The queue row is a debounced snapshot and can lag the record by a track
 * change, so the record's track identity decides which one it means: the row's
 * cursor when it agrees, else the record's own index, else the row's cursor
 * from the top (a position inside some other song would be nonsense).
 */
export function chooseStartPoint(
  record: ResumeRecord,
  queue: Pick<PersistedQueue, 'tracks' | 'currentIndex'>,
): { readonly index: number; readonly positionMs: number } {
  let index = queue.currentIndex;
  let matched = false;
  if (queue.tracks[queue.currentIndex]?.identifier === record.trackIdentifier) {
    matched = true;
  } else if (queue.tracks[record.currentIndex]?.identifier === record.trackIdentifier) {
    index = record.currentIndex;
    matched = true;
  }
  if (!matched) return { index, positionMs: 0 };

  const target = queue.tracks[index];
  let positionMs = record.positionMs;
  // Never seek a live stream, a nonsense value, or past the end of the song
  // (Lavalink would end the track instantly and skip it).
  if (
    target === undefined ||
    target.isStream ||
    positionMs < 0 ||
    (target.durationMs > 0 && positionMs >= target.durationMs)
  ) {
    positionMs = 0;
  }
  return { index, positionMs };
}

/* ------------------------------------------------------------ restore loop */

export interface RestoreRoomsDeps {
  readonly store: ResumeStore;
  readonly now: () => number;
  readonly guildPresent: (guildId: string) => boolean;
  readonly channelIsVoice: (guildId: string, voiceChannelId: string) => boolean;
  readonly humanListeners: (guildId: string, voiceChannelId: string) => number;
  readonly hasPlayer: (guildId: string) => boolean;
  readonly loadQueue: (guildId: string, voiceChannelId: string) => Promise<PersistedQueue | null>;
  readonly startRoom: (input: {
    readonly record: ResumeRecord;
    readonly queue: PersistedQueue;
    readonly index: number;
    readonly positionMs: number;
  }) => Promise<void>;
  readonly logger: {
    readonly info: (obj: object, msg: string) => void;
    readonly warn: (obj: object, msg: string) => void;
  };
}

export interface RestoreSummary {
  readonly restored: readonly {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly positionMs: number;
    readonly index: number;
  }[];
  readonly skipped: readonly {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly reason: ResumeSkipReason;
  }[];
  readonly failed: readonly {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly error: unknown;
  }[];
}

/**
 * Rejoin every room this bot's records say it was playing in.
 *
 * Sequential on purpose: each join is a voice handshake plus a Lavalink
 * round trip, and doing them one at a time keeps the claim (which is per-bot,
 * one room at a time) meaningful. Every outcome is logged with its reason —
 * "it did not come back" must be answerable from the logs alone.
 */
export async function restorePlayingRooms(deps: RestoreRoomsDeps): Promise<RestoreSummary> {
  const restored: {
    guildId: string;
    voiceChannelId: string;
    positionMs: number;
    index: number;
  }[] = [];
  const skipped: { guildId: string; voiceChannelId: string; reason: ResumeSkipReason }[] = [];
  const failed: { guildId: string; voiceChannelId: string; error: unknown }[] = [];

  let records: readonly ResumeRecord[];
  try {
    records = await deps.store.loadAll();
  } catch (error) {
    deps.logger.warn({ err: error }, 'Could not read the saved rooms; nothing restored');
    return { restored, skipped, failed };
  }

  // A room that is not picked up now must not be picked up by some later
  // restart either, so every skip forgets the record.
  const skip = async (
    record: ResumeRecord,
    reason: ResumeSkipReason,
    forget: boolean,
  ): Promise<void> => {
    const { guildId, voiceChannelId } = record;
    skipped.push({ guildId, voiceChannelId, reason });
    deps.logger.info(
      { guildId, voiceChannelId, reason, ageMs: deps.now() - record.savedAt },
      'Not restoring a saved room',
    );
    if (forget) await deps.store.remove(guildId, voiceChannelId).catch(() => undefined);
  };

  for (const record of records) {
    const { guildId, voiceChannelId } = record;
    const decision = decideRoomResume({
      record,
      now: deps.now(),
      guildPresent: deps.guildPresent(guildId),
      channelIsVoice: deps.channelIsVoice(guildId, voiceChannelId),
      humanListeners: deps.humanListeners(guildId, voiceChannelId),
      hasPlayer: deps.hasPlayer(guildId),
    });
    if (decision.kind === 'skip') {
      await skip(record, decision.reason, true);
      continue;
    }

    let queue: PersistedQueue | null;
    try {
      queue = await deps.loadQueue(guildId, voiceChannelId);
    } catch (error) {
      deps.logger.warn({ err: error, guildId, voiceChannelId }, 'Could not load the saved queue');
      failed.push({ guildId, voiceChannelId, error });
      continue;
    }
    if (queue === null) {
      await skip(record, 'empty-queue', true);
      continue;
    }

    // Another bot may hold this room (a /play routed here during startup, or
    // a second bot that remembers the same room). The claim decides, once.
    // The record is kept on a lost claim: whoever won is playing it.
    const won = await deps.store.claim(guildId, voiceChannelId, { respectOwner: true });
    if (!won) {
      await skip(record, 'claimed-elsewhere', true);
      continue;
    }

    try {
      const start = chooseStartPoint(record, queue);
      try {
        await deps.startRoom({ record, queue, index: start.index, positionMs: start.positionMs });
        restored.push({
          guildId,
          voiceChannelId,
          positionMs: start.positionMs,
          index: start.index,
        });
        deps.logger.info(
          { guildId, voiceChannelId, positionMs: start.positionMs, index: start.index },
          'Restored a playing room after restart',
        );
      } catch (error) {
        deps.logger.warn(
          { err: error, guildId, voiceChannelId },
          'Could not restore a playing room',
        );
        failed.push({ guildId, voiceChannelId, error });
        await deps.store.remove(guildId, voiceChannelId).catch(() => undefined);
      }
    } finally {
      // The claim only has to cover the join; once the player exists the
      // normal owner key takes over.
      await deps.store.release(guildId, voiceChannelId).catch(() => undefined);
    }
  }

  deps.logger.info(
    { restored: restored.length, skipped: skipped.length, failed: failed.length },
    'Restart restore finished',
  );
  return { restored, skipped, failed };
}

/* ----------------------------------------------------------------- 24/7 gate */

/**
 * Whether the 24/7 pass should still rejoin a room and wait in it.
 *
 * The 24/7 pass runs on the primary alongside every bot's playing restore. A
 * room one bot is about to resume playing (it holds a fresh record AND people
 * are there to hear it) must be left alone; an empty one will be skipped by
 * that bot, so 24/7 still takes it.
 */
export function decideStayConnectedRestore(facts: {
  readonly hasPlayer: boolean;
  readonly heldBy: string | undefined;
  readonly humanListeners: number;
}): 'restore' | 'already-playing' | 'resumed-by-another-bot' {
  if (facts.hasPlayer) return 'already-playing';
  if (facts.heldBy !== undefined && facts.humanListeners > 0) return 'resumed-by-another-bot';
  return 'restore';
}

/* ------------------------------------------------------------------ tracker */

/**
 * Keeps a bot's records equal to "the rooms I am playing in right now".
 *
 * Never throws: a Redis hiccup must not break playback, it only costs a
 * resume. Once shutdown begins the tracker freezes — the teardown that follows
 * reports every room as stopped and the bot leaving the channel, and neither
 * is the room ending.
 */
export class ResumeTracker {
  readonly #store: ResumeStore;
  readonly #now: () => number;
  #shuttingDown = false;

  constructor(store: ResumeStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  async sync(view: PlayingRoomView): Promise<void> {
    if (this.#shuttingDown) return;
    try {
      if (view.isPlaying && !view.paused && view.currentIdentifier !== null) {
        // Field order is the JSON order; keep it stable.
        await this.#store.save({
          guildId: view.guildId,
          voiceChannelId: view.voiceChannelId,
          textChannelId: view.textChannelId,
          trackIdentifier: view.currentIdentifier,
          currentIndex: view.currentIndex,
          positionMs: view.positionMs,
          savedAt: this.#now(),
        });
      } else {
        await this.#store.remove(view.guildId, view.voiceChannelId);
      }
    } catch (error) {
      logger.debug({ err: error, guildId: view.guildId }, 'Could not sync a resume record');
    }
  }

  async forget(guildId: string, voiceChannelId: string): Promise<void> {
    if (this.#shuttingDown) return;
    try {
      await this.#store.remove(guildId, voiceChannelId);
    } catch (error) {
      logger.debug({ err: error, guildId }, 'Could not forget a resume record');
    }
  }

  async checkpoint(views: readonly PlayingRoomView[]): Promise<void> {
    await Promise.all(views.map(async (view) => this.sync(view)));
  }

  /**
   * Write the final state of every room, THEN freeze. The order is the point:
   * freezing first would drop the very save that carries the position.
   */
  async beginShutdown(views: readonly PlayingRoomView[]): Promise<void> {
    await this.checkpoint(views);
    this.#shuttingDown = true;
  }
}

/* -------------------------------------------------------------------- Redis */

/**
 * Claim a room for this bot, writing the same keys the command router reads.
 *
 * Refuses (returns 0) when the room is promised to another bot, owned by
 * another bot (when `respectOwner`), or this bot is already promised to a
 * different room — e.g. a /play the router sent here during startup. Because
 * the keys are the router's own, a /play for this room that arrives while we
 * join is sent to us instead of to a second bot.
 *
 * KEYS: room claim, this bot's claim, room owner. ARGV: bot id, voice channel
 * id, ttl ms, '1' to respect an existing owner.
 */
export const CLAIM_ROOM_FOR_RESUME_SCRIPT = `
local holder = redis.call('GET', KEYS[1])
if holder and holder ~= ARGV[1] then return 0 end
if ARGV[4] == '1' then
  local owner = redis.call('GET', KEYS[3])
  if owner then
    local ok, decoded = pcall(cjson.decode, owner)
    if ok and type(decoded) == 'table' and decoded.botId ~= ARGV[1] then return 0 end
  end
end
local promised = redis.call('GET', KEYS[2])
if promised and promised ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1
`;

function parseRecord(raw: string | null | undefined): ResumeRecord | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    const {
      guildId,
      voiceChannelId,
      textChannelId,
      trackIdentifier,
      currentIndex,
      positionMs,
      savedAt,
    } = value;
    if (
      typeof guildId !== 'string' ||
      typeof voiceChannelId !== 'string' ||
      (textChannelId !== null && typeof textChannelId !== 'string') ||
      typeof trackIdentifier !== 'string' ||
      typeof currentIndex !== 'number' ||
      typeof positionMs !== 'number' ||
      typeof savedAt !== 'number'
    ) {
      return undefined;
    }
    return {
      guildId,
      voiceChannelId,
      textChannelId,
      trackIdentifier,
      currentIndex,
      positionMs,
      savedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * The Redis-backed {@link ResumeStore}. Every method fails soft: a Redis
 * problem means "nothing saved", never a broken bot.
 */
export class RedisResumeStore implements ResumeStore {
  // A getter because BotClient drops its Redis handle after a failed boot check.
  readonly #redis: () => Redis | undefined;
  readonly #botId: string;

  constructor(options: { readonly redis: () => Redis | undefined; readonly botId: string }) {
    this.#redis = options.redis;
    this.#botId = options.botId;
  }

  async save(record: ResumeRecord): Promise<void> {
    const redis = this.#redis();
    if (redis === undefined) return;
    try {
      const key = resumeRecordsKey(this.#botId);
      await redis.hset(key, `${record.guildId}:${record.voiceChannelId}`, JSON.stringify(record));
      await redis.expire(key, RESUME_RECORD_TTL_SECONDS);
    } catch (error) {
      logger.debug({ err: error }, 'Could not save a resume record');
    }
  }

  async remove(guildId: string, voiceChannelId: string): Promise<void> {
    const redis = this.#redis();
    if (redis === undefined) return;
    try {
      await redis.hdel(resumeRecordsKey(this.#botId), `${guildId}:${voiceChannelId}`);
    } catch (error) {
      logger.debug({ err: error }, 'Could not remove a resume record');
    }
  }

  async loadAll(): Promise<readonly ResumeRecord[]> {
    const redis = this.#redis();
    if (redis === undefined) return [];
    try {
      const all = await redis.hgetall(resumeRecordsKey(this.#botId));
      return Object.values(all)
        .map((raw) => parseRecord(raw))
        .filter((record): record is ResumeRecord => record !== undefined);
    } catch (error) {
      logger.debug({ err: error }, 'Could not read resume records');
      return [];
    }
  }

  async claim(
    guildId: string,
    voiceChannelId: string,
    options: { readonly respectOwner: boolean },
  ): Promise<boolean> {
    const redis = this.#redis();
    // Single-bot development: nobody to race.
    if (redis === undefined) return true;
    try {
      const result = await redis.eval(
        CLAIM_ROOM_FOR_RESUME_SCRIPT,
        3,
        roomClaimKey(guildId, voiceChannelId),
        botClaimKey(this.#botId),
        playerRoomOwnerKey(guildId, voiceChannelId),
        this.#botId,
        voiceChannelId,
        String(CLAIM_TTL_MS),
        options.respectOwner ? '1' : '0',
      );
      return result === 1;
    } catch (error) {
      // Joining a channel on a guess is how two bots end up in it.
      logger.debug({ err: error }, 'Could not claim a room for resume');
      return false;
    }
  }

  async release(guildId: string, voiceChannelId: string): Promise<void> {
    const redis = this.#redis();
    if (redis === undefined) return;
    try {
      await redis.del(botClaimKey(this.#botId));
      await redis.del(roomClaimKey(guildId, voiceChannelId));
    } catch (error) {
      logger.debug({ err: error }, 'Could not release a resume claim');
    }
  }

  async heldElsewhere(
    guildId: string,
    voiceChannelId: string,
    now: number,
  ): Promise<string | undefined> {
    const redis = this.#redis();
    if (redis === undefined) return undefined;
    try {
      const field = `${guildId}:${voiceChannelId}`;
      const ids = await redis.smembers(playerBotIndexKey());
      for (const id of ids) {
        if (id === this.#botId) continue;
        const found = parseRecord(await redis.hget(resumeRecordsKey(id), field));
        if (found !== undefined && now - found.savedAt <= RESUME_MAX_AGE_MS) return id;
      }
      return undefined;
    } catch (error) {
      logger.debug({ err: error }, 'Could not look for another bot’s resume record');
      return undefined;
    }
  }
}

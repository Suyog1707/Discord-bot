/**
 * Finding, and talking to, the container that owns a room.
 *
 * A room belongs to exactly one bot. Once each bot has its own container, a
 * command can arrive at one that does not own the room it is about — so the
 * first question is always "who has this?", and the second is "ask them".
 *
 * The answer lives in Redis, written by the owner as it takes a room and
 * removed as it lets go, carrying the address to reach it on. Asking every
 * sibling in turn would work too and is what `/rooms` is for, but it costs a
 * fan-out on a path that runs on every command.
 *
 * It no longer *calls* anybody. The command router sends each interaction to
 * the bot that should run it, so the question "who has this?" is now asked to
 * decide whether a room is free, not to decide who to forward to. Every lookup
 * still fails soft: a stale answer must degrade one command, never block the
 * music.
 */
import {
  botClaimKey,
  PLAYER_BOT_GUILDS_SENTINEL,
  PLAYER_BOT_TTL_SECONDS,
  playerBotGuildsKey,
  playerBotIndexKey,
  playerBotKey,
  playerRoomOwnerKey,
  roomClaimKey,
  type BotPresence,
} from '@discord-music/shared';
import { readLiveBots, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';

const logger = getLogger('peers');

/** Who owns a room, and where to reach them. */
export interface RoomOwner {
  readonly botId: string;
}

export interface PeerDirectoryOptions {
  readonly redis: Redis | undefined;
  /** This container's own id, so it can tell itself apart from a sibling. */
  readonly selfBotId: string;
  /** Snapshot lifetime, reused so ownership cannot outlive what it points at. */
  readonly ttlSeconds: number;
}

export class PeerDirectory {
  readonly #redis: Redis | undefined;
  readonly #selfBotId: string;
  readonly #ttlSeconds: number;

  constructor(options: PeerDirectoryOptions) {
    this.#redis = options.redis;
    this.#selfBotId = options.selfBotId;
    this.#ttlSeconds = options.ttlSeconds;
  }

  get selfBotId(): string {
    return this.#selfBotId;
  }

  /**
   * Publish this container's own presence, and refresh it.
   *
   * Written repeatedly rather than once at startup: the entry expires, so
   * being in the directory means "answered within the last minute" rather than
   * "started at some point". Nothing has to clean up after a container that
   * dies, which is the only kind of cleanup that survives a crash.
   */
  async announceSelf(presence: BotPresence): Promise<void> {
    const redis = this.#redis;
    if (redis === undefined) return;
    // Stamped here rather than by the caller: this is the write, so this is the
    // only place that can promise the timestamp matches it.
    const entry: BotPresence = { ...presence, sentAt: Date.now() };
    await Promise.all([
      redis
        .set(playerBotKey(entry.botId), JSON.stringify(entry), 'EX', PLAYER_BOT_TTL_SECONDS)
        .catch(() => undefined),
      // The index outlives the entries on purpose: it is the only way to find
      // them again, and a member whose entry has expired is simply skipped.
      redis.sadd(playerBotIndexKey(), presence.botId).catch(() => undefined),
    ]);
  }

  /** Leave the directory deliberately, rather than by timing out. */
  async withdrawSelf(botId: string): Promise<void> {
    if (this.#redis === undefined) return;
    await this.#redis.del(playerBotKey(botId)).catch(() => undefined);
  }

  /**
   * Publish the servers this container is in, replacing whatever was there.
   *
   * Read by the command router on every command, in place of a Postgres
   * query. Replaced whole rather than patched, so a server this bot was removed
   * from while it was down drops out without anybody having to notice. One
   * transaction, so the router never reads the list half-written.
   */
  async indexGuilds(guildIds: readonly string[]): Promise<void> {
    const redis = this.#redis;
    if (redis === undefined) return;
    const key = playerBotGuildsKey(this.#selfBotId);
    await redis
      .multi()
      .del(key)
      .sadd(key, PLAYER_BOT_GUILDS_SENTINEL, ...guildIds)
      .exec()
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'Could not publish this bot’s server list');
      });
  }

  /**
   * Joined a server while running.
   *
   * Deliberately no sentinel: before the ready-time list exists, a partial set
   * must still read as "not published", so the router keeps asking Postgres.
   */
  async addGuild(guildId: string): Promise<void> {
    if (this.#redis === undefined) return;
    await this.#redis.sadd(playerBotGuildsKey(this.#selfBotId), guildId).catch(() => 0);
  }

  /** Removed from a server while running. */
  async removeGuild(guildId: string): Promise<void> {
    if (this.#redis === undefined) return;
    await this.#redis.srem(playerBotGuildsKey(this.#selfBotId), guildId).catch(() => 0);
  }

  /**
   * Every container that has checked in recently.
   *
   * Members whose entry has expired are dropped from the index as they are
   * found, so a player that is retired rather than restarted stops being asked
   * about instead of being asked about forever.
   */
  async liveBots(): Promise<readonly BotPresence[]> {
    const redis = this.#redis;
    if (redis === undefined) return [];
    try {
      return await readLiveBots(redis);
    } catch (error) {
      logger.debug({ err: error }, 'Fleet presence lookup failed');
      return [];
    }
  }

  /**
   * Which bots the command router has promised to a channel.
   *
   * Read alongside presence when deciding, so this container agrees with a
   * decision already made rather than making a second one. Best-effort: a
   * failed read degrades to "no promises outstanding", which is what it was
   * before the router existed.
   */
  async claimedRooms(): Promise<ReadonlyMap<string, string>> {
    const redis = this.#redis;
    if (redis === undefined) return new Map();

    try {
      const ids = await redis.smembers(playerBotIndexKey());
      if (ids.length === 0) return new Map();

      const claims = await redis.mget(...ids.map((id) => botClaimKey(id)));
      return new Map(
        ids.flatMap((id, index) => {
          const voiceChannelId = claims[index];
          return voiceChannelId == null ? [] : [[id, voiceChannelId] as const];
        }),
      );
    } catch (error) {
      logger.debug({ err: error }, 'Claim lookup failed');
      return new Map();
    }
  }

  /**
   * Let go of a promise, now that it has been kept.
   *
   * The TTL would do this eventually, but "eventually" is fifteen seconds of
   * a bot looking busy to the next person who asks.
   */
  async releaseClaim(botId: string, guildId: string, voiceChannelId: string): Promise<void> {
    if (this.#redis === undefined) return;
    await Promise.all([
      this.#redis.del(botClaimKey(botId)).catch(() => 0),
      this.#redis.del(roomClaimKey(guildId, voiceChannelId)).catch(() => 0),
    ]);
  }

  /** Claim a room, so siblings can route to this container for it. */
  async announce(guildId: string, voiceChannelId: string, owner: RoomOwner): Promise<void> {
    if (this.#redis === undefined) return;
    await this.#redis
      .set(
        playerRoomOwnerKey(guildId, voiceChannelId),
        JSON.stringify(owner),
        'EX',
        this.#ttlSeconds,
      )
      .catch(() => undefined);
  }

  /** Let a room go. A stale claim would send commands into a void. */
  async release(guildId: string, voiceChannelId: string): Promise<void> {
    if (this.#redis === undefined) return;
    await this.#redis.del(playerRoomOwnerKey(guildId, voiceChannelId)).catch(() => undefined);
  }

  /**
   * Who serves this room, or undefined when nobody does — or when Redis
   * cannot say. A caller that owns the room locally should check that first
   * and never reach this.
   */
  async ownerOf(guildId: string, voiceChannelId: string): Promise<RoomOwner | undefined> {
    if (this.#redis === undefined) return undefined;
    try {
      const raw = await this.#redis.get(playerRoomOwnerKey(guildId, voiceChannelId));
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw) as Partial<RoomOwner>;
      if (typeof parsed.botId !== 'string') return undefined;
      return { botId: parsed.botId };
    } catch (error) {
      logger.debug({ err: error, guildId, voiceChannelId }, 'Room owner lookup failed');
      return undefined;
    }
  }

  /**
   * Who has this room right now: the bot serving it, or failing that the bot
   * the command router last promised it to. Both in one round trip.
   *
   * Undefined when nobody does, or when Redis cannot say — a routed join then
   * goes ahead, which is what the router decided.
   */
  async roomHolder(guildId: string, voiceChannelId: string): Promise<string | undefined> {
    if (this.#redis === undefined) return undefined;
    try {
      const [owner, promised] = await this.#redis.mget(
        playerRoomOwnerKey(guildId, voiceChannelId),
        roomClaimKey(guildId, voiceChannelId),
      );
      const ownerId = owner == null ? undefined : (JSON.parse(owner) as Partial<RoomOwner>).botId;
      if (typeof ownerId === 'string') return ownerId;
      return promised ?? undefined;
    } catch (error) {
      logger.debug({ err: error, guildId, voiceChannelId }, 'Room holder lookup failed');
      return undefined;
    }
  }
}

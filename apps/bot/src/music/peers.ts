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
 * Every lookup and every call is bounded and fails soft. A sibling that is
 * slow or gone must degrade one command, never block the music.
 */
import {
  PLAYER_BOT_TTL_SECONDS,
  playerBotIndexKey,
  playerBotKey,
  playerRoomOwnerKey,
  type BotPresence,
} from '@discord-music/shared';
import { readLiveBots, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';

import type { IntentResult, RoomIntent } from './intent.js';
import type { JoinOptions } from './music-manager.js';

const logger = getLogger('peers');

/** Who owns a room, and where to reach them. */
export interface RoomOwner {
  readonly botId: string;
  /** e.g. `http://dmp-bot-player-2:8080` — reachable only inside the network. */
  readonly baseUrl: string;
}

export interface PeerDirectoryOptions {
  readonly redis: Redis | undefined;
  /** This container's own id, so it can tell itself apart from a sibling. */
  readonly selfBotId: string;
  /** How long a peer has to answer before the caller gives up on it. */
  readonly timeoutMs: number;
  /** Snapshot lifetime, reused so ownership cannot outlive what it points at. */
  readonly ttlSeconds: number;
}

/** What a container answers when asked to take a room. */
export type JoinOutcome =
  | { readonly kind: 'joined' }
  /**
   * The player is already in a different channel of this guild. One token
   * holds one voice connection per server, so this is a refusal, not a move —
   * the allocator's picture was a moment out of date and it should look again.
   */
  | { readonly kind: 'busy'; readonly voiceChannelId: string }
  | { readonly kind: 'error'; readonly message: string };

export class PeerDirectory {
  readonly #redis: Redis | undefined;
  readonly #selfBotId: string;
  readonly #timeoutMs: number;
  readonly #ttlSeconds: number;

  constructor(options: PeerDirectoryOptions) {
    this.#redis = options.redis;
    this.#selfBotId = options.selfBotId;
    this.#timeoutMs = options.timeoutMs;
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
   * Ask a container to take a room.
   *
   * Separate from `sendIntent` because it is the one call about a room that
   * does not exist yet: every intent is applied to a player that is already
   * there, and this is what puts one there.
   */
  async sendJoin(baseUrl: string, options: JoinOptions): Promise<JoinOutcome> {
    try {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      return (await response.json()) as JoinOutcome;
    } catch (error) {
      logger.warn({ err: error, baseUrl }, 'Peer did not answer a join');
      return {
        kind: 'error',
        message: 'That player is not responding right now. Try again shortly.',
      };
    }
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
      if (typeof parsed.botId !== 'string' || typeof parsed.baseUrl !== 'string') return undefined;
      return { botId: parsed.botId, baseUrl: parsed.baseUrl };
    } catch (error) {
      logger.debug({ err: error, guildId, voiceChannelId }, 'Room owner lookup failed');
      return undefined;
    }
  }

  /**
   * Run an intent on the container that owns the room.
   *
   * A failure here is reported as a result rather than thrown, because every
   * caller is rendering a reply to somebody: "that player is not responding"
   * is a better answer than an exception trace.
   */
  async sendIntent(owner: RoomOwner, intent: RoomIntent): Promise<IntentResult> {
    try {
      const response = await fetch(`${owner.baseUrl}/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const body = (await response.json()) as IntentResult;
      if (!response.ok && body.kind !== 'error') {
        return { kind: 'error', message: `Player ${owner.botId} refused that.` };
      }
      return body;
    } catch (error) {
      logger.warn(
        { err: error, botId: owner.botId, action: intent.action },
        'Peer did not answer an intent',
      );
      return {
        kind: 'error',
        message: `The player holding that channel is not responding. Try again shortly.`,
      };
    }
  }
}

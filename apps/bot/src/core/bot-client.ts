/**
 * `BotClient` — the discord.js `Client` extended with this project's services.
 *
 * Everything long-lived (registries, database, Redis, the music engine) hangs
 * off the client so handlers receive it explicitly through their context
 * instead of importing module-level singletons, which keeps them testable.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPrismaClient, pingDatabase, type PrismaClient } from '@discord-music/database';
import {
  ConfigurationError,
  PLAYER_EVENT_CHANNEL,
  PLAYER_STATE_TTL_SECONDS,
  playerRoomIndexKey,
  playerStateKey,
} from '@discord-music/shared';
import {
  closeRedis,
  connectRedis,
  createRedisClient,
  type Redis,
} from '@discord-music/shared/redis';
import { randomUUID } from 'node:crypto';

import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

import { getEnv, getLavalinkNode, isDevelopment, isProduction } from '../config/env.js';
import { getLogger, logger, type Logger } from '../lib/logger.js';
import { PlayerCommandSubscriber } from '../music/command-subscriber.js';
import { MusicManager } from '../music/music-manager.js';
import type { PlayerRouter } from '../music/player-router.js';
import type { PeerDirectory } from '../music/peers.js';
import { QueueStore } from '../music/queue-store.js';
import { DislikesService } from '../services/dislikes-service.js';
import { FavoritesService } from '../services/favorites-service.js';
import { GuildService } from '../services/guild-service.js';
import { PlaylistsService } from '../services/playlists-service.js';
import { SpotifyService } from '../services/spotify-service.js';
import { CommandRegistry } from './command-registry.js';
import { type AiStack, createAiStack } from '../ai/index.js';
import { CooldownManager } from './cooldown.js';
import { EventRegistry } from './event-registry.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** discord.js signals a rejected credential with the `TokenInvalid` error code. */
function isInvalidTokenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === 'TokenInvalid' ||
      (error as { code?: unknown }).code === 'TokenMissing')
  );
}

/**
 * Gateway intents.
 *
 * `GuildVoiceStates` is required to know which voice channel a user is in.
 * `MessageContent` is deliberately omitted — it is a privileged intent this
 * project does not need, since all interaction is via slash commands.
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
] as const;

/**
 * A player announces nothing and reads no messages — it exists to hold a voice
 * connection — so it asks for the minimum Discord will let it have.
 */
const PLAYER_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] as const;

/**
 * Which Discord application this client logs in as.
 *
 * Discord allows one voice connection per guild per *token*, so playing in
 * several channels of one server at once means running as several
 * applications. The primary is the one users interact with: it owns the slash
 * commands and the dashboard command channel. A worker is a headless player
 * the primary hands a channel to.
 */
export interface BotIdentity {
  readonly token: string;
  /** Application id — slash-command deployment and invite links. */
  readonly clientId: string;
  /** Short name for logs, e.g. "main" or "player-2". */
  readonly label: string;
  readonly role: 'primary' | 'player';
}

export class BotClient extends Client {
  /** Which application this client is. */
  readonly identity: BotIdentity;
  /**
   * Per-client run id.
   *
   * Was process-wide, which was fine when a process was one bot. With a fleet
   * it has to be per client, or the "is a second bot running on this token?"
   * diagnostic reports every player under one id and answers nothing.
   */
  readonly instanceId: string = randomUUID().slice(0, 8);
  readonly commands = new CommandRegistry();
  readonly events = new EventRegistry();
  readonly logger: Logger = logger;
  readonly prisma: PrismaClient;
  /** Per-user command cooldowns (Redis-backed when available). */
  readonly cooldowns: CooldownManager;
  /** Domain services. Named container because discord.js already owns `client.guilds`. */
  readonly services: {
    readonly guilds: GuildService;
    readonly queueStore: QueueStore;
    readonly favorites: FavoritesService;
    readonly dislikes: DislikesService;
    readonly playlists: PlaylistsService;
    readonly spotify: SpotifyService;
  };
  /**
   * Music engine, or `undefined` when Lavalink is not configured (allowed in
   * development). Commands go through `requireMusic()` for a friendly error.
   */
  readonly music: MusicManager | undefined;

  /**
   * The fleet, seen as one bot.
   *
   * Assigned after construction by the entry point, because it spans every
   * client and none of them can build it alone. Undefined when Lavalink is not
   * configured, exactly as `music` is.
   */
  router: PlayerRouter | undefined;

  /**
   * How siblings reach this container, and how it finds them. Assigned with
   * the router, since both span the fleet.
   */
  peers: PeerDirectory | undefined;

  /**
   * The address siblings reach this container on, e.g.
   * `http://dmp-bot-player-2:8080`. Undefined while every bot shares one
   * process, where there is nobody to reach.
   */
  peerBaseUrl: string | undefined;

  /**
   * Intent parsing, taste and recommendations. Always present — with nothing
   * configured its services are simply disabled, so callers never branch.
   */
  readonly ai: AiStack;

  /**
   * Redis, or `undefined` when it is not configured or was unreachable at boot.
   *
   * Optional in development so the bot runs without infrastructure; the env
   * schema makes it mandatory in production, and an unreachable server there is
   * a startup failure. Consumers must handle `undefined` and degrade — features
   * that require it should be skipped, not silently behave differently.
   */
  get redis(): Redis | undefined {
    return this.#redis;
  }

  #redis: Redis | undefined;
  #commandSubscriber: PlayerCommandSubscriber | undefined;
  #shuttingDown = false;

  constructor(identity?: BotIdentity) {
    const resolved: BotIdentity = identity ?? {
      token: getEnv().BOT_TOKEN,
      clientId: getEnv().BOT_CLIENT_ID,
      label: 'main',
      role: 'primary',
    };

    super({
      intents: resolved.role === 'player' ? [...PLAYER_INTENTS] : [...INTENTS],
      partials: [Partials.Channel, Partials.GuildMember],
      // Cache only what the bot reads. Message/reaction caches would grow unbounded.
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        ReactionManager: 0,
        GuildMemberManager: 200,
      }),
      allowedMentions: { parse: ['users'], repliedUser: false },
    });

    this.identity = resolved;
    const env = getEnv();

    this.prisma = getPrismaClient({
      databaseUrl: env.DATABASE_URL,
      logQueries: isDevelopment() && env.LOG_LEVEL === 'trace',
    });

    this.#redis =
      env.REDIS_URL === undefined
        ? undefined
        : createRedisClient({ url: env.REDIS_URL, logger: getLogger('redis') });

    this.cooldowns = new CooldownManager(this.#redis);
    this.services = {
      guilds: new GuildService(this.prisma),
      queueStore: new QueueStore(this.prisma),
      favorites: new FavoritesService(this.prisma),
      dislikes: new DislikesService(this.prisma),
      playlists: new PlaylistsService(this.prisma),
      spotify: new SpotifyService(this.prisma),
    };

    const lavalinkNode = getLavalinkNode();
    this.music =
      lavalinkNode === undefined
        ? undefined
        : new MusicManager({
            client: this,
            node: lavalinkNode,
            store: this.services.queueStore,
            guilds: this.services.guilds,
            spotify: this.services.spotify,
            // Realtime events ride the shared Redis connection; without Redis
            // the dashboard simply has no live stream (allowed in development).
            publishEvent: (payload) => {
              this.#redis?.publish(PLAYER_EVENT_CHANNEL, payload).catch(() => 0);
            },
            /**
             * The same payload, retained so a dashboard that connects between
             * events still opens on the real state instead of an empty player.
             * Every event is a full snapshot, so this is a plain last-write-
             * wins SET with no ordering concerns: one bot owns one room, so
             * one writer owns one key, and a stale value is corrected by the
             * very next event.
             *
             * The room index beside it is how the dashboard enumerates a
             * server's rooms without scanning Redis for keys.
             */
            retainEvent: (guildId, voiceChannelId, payload) => {
              const redis = this.#redis;
              if (redis === undefined) return;
              const key = playerStateKey(guildId, voiceChannelId);
              const index = playerRoomIndexKey(guildId);
              if (payload === null) {
                redis.del(key).catch(() => 0);
                redis.srem(index, voiceChannelId).catch(() => 0);
                // Let the room go before anything else can be told to send
                // commands into a container that is no longer in it.
                void this.peers?.release(guildId, voiceChannelId).catch(() => undefined);
                return;
              }
              redis.set(key, payload, 'EX', PLAYER_STATE_TTL_SECONDS).catch(() => 0);
              redis.sadd(index, voiceChannelId).catch(() => 0);
              // Claim the room, so a sibling holding a command for it knows
              // where to send it. Written on every event rather than only on
              // connect, which doubles as the heartbeat that keeps the claim
              // from expiring under a long-running session.
              this.#announceRoom(guildId, voiceChannelId);
              // The index must not outlive the snapshots it points at; a room
              // whose bot died without a disconnect would otherwise haunt the
              // dashboard forever.
              redis.expire(index, PLAYER_STATE_TTL_SECONDS).catch(() => 0);
            },
          });

    // The recommendation stack is built unconditionally: with no keys set it is
    // a null LLM and a disabled discovery service, and autoplay falls straight
    // through to its original YouTube-mix behaviour. Building it either way
    // keeps `client.ai` non-optional for every consumer.
    this.ai = createAiStack({
      env,
      prisma: this.prisma,
      dislikes: this.services.dislikes,
      // The same reader `/spotify` and `/play` use. Autoplay reads the linked
      // libraries of whoever is in the voice channel, so the room's own music
      // counts as familiar rather than being invisible to the recommender.
      spotify: this.services.spotify,
      ...(this.#redis && { redis: this.#redis }),
    });
    /**
     * Every player wires its own autoplay.
     *
     * The resolvers are single-slot setters, which would be a problem if the
     * planner were shared — the last manager to attach would own every room's
     * resolution, and `presentListeners` would report one arbitrary bot's
     * audience for all of them. It is not shared: each client builds its own
     * stack above, so each manager attaches to its own planner and resolves
     * only for its own rooms. The ledger underneath is keyed by room, so two
     * channels of one server keep separate histories, reservations and
     * anti-repeat even though they run on different bots.
     */
    this.music?.attachAutoplay(this.ai.autoplay, this.ai.orchestrator, this.ai.planner);
  }

  /**
   * Load commands and events, verify dependencies, then connect to the gateway.
   *
   * Ordering matters: handlers must be attached before `login()` so no early
   * gateway event is dropped.
   */
  async start(): Promise<void> {
    const startedAt = Date.now();

    const commandsDirectory = isDevelopment()
      ? join(moduleDirectory, '..', 'commands')
      : join(moduleDirectory, 'commands');

    const eventsDirectory = isDevelopment()
      ? join(moduleDirectory, '..', 'events')
      : join(moduleDirectory, 'events');

    // A worker registers no slash commands with Discord, so loading them would
    // only build a registry nothing can ever reach. It still needs the event
    // handlers — voice state changes are how its own player learns the room
    // emptied.
    if (this.identity.role === 'primary') {
      await this.commands.loadFrom(commandsDirectory);
    }
    await this.events.loadFrom(eventsDirectory);
    this.events.attach(this);

    await this.#verifyDependencies();
    await this.#connect();
    // Only the primary listens for dashboard commands. Every bot subscribing
    // would mean N handlers racing one instruction, and it would break the
    // publisher's subscriber-count check for whether the bot is online at all.
    if (this.identity.role === 'primary') {
      await this.#startCommandSubscriber();
    }

    this.logger.info(
      { durationMs: Date.now() - startedAt, player: this.identity.label },
      'Bot startup complete',
    );
  }

  /** Advertise that this container serves a room, if it can be reached at all. */
  #announceRoom(guildId: string, voiceChannelId: string): void {
    const peers = this.peers;
    const baseUrl = this.peerBaseUrl;
    if (peers === undefined || baseUrl === undefined) return;
    void peers
      .announce(guildId, voiceChannelId, { botId: this.identity.label, baseUrl })
      .catch(() => undefined);
  }

  /**
   * Log in to the Discord gateway.
   *
   * discord.js reports a bad credential as `TokenInvalid`, whose message
   * ("An invalid token was provided") does not say *which* value is wrong or
   * where to get a correct one. It is translated into a `ConfigurationError` so
   * it prints as a single actionable line instead of a stack trace — this is an
   * operator problem, not a crash.
   */
  async #connect(): Promise<void> {
    try {
      await this.login(this.identity.token);
    } catch (error) {
      if (isInvalidTokenError(error)) {
        throw new ConfigurationError(
          `The token for player "${this.identity.label}" is not a valid Discord bot token. ` +
            'Copy it from ' +
            'https://discord.com/developers/applications → your application → Bot → Reset Token, ' +
            'then set BOT_TOKEN in .env and re-run `pnpm run check:env`.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Listen for dashboard player commands over Redis pub/sub.
   *
   * Requires both Redis and the music engine; missing either just means live
   * control from the dashboard is off, which #verifyDependencies already
   * reported. Failure here is logged, not fatal — slash commands still work.
   */
  async #startCommandSubscriber(): Promise<void> {
    const redisUrl = getEnv().REDIS_URL;
    if (this.#redis === undefined || redisUrl === undefined || this.router === undefined) return;

    try {
      this.#commandSubscriber = new PlayerCommandSubscriber(redisUrl, this.router);
      await this.#commandSubscriber.start();
    } catch (error) {
      this.logger.warn({ err: error }, 'Dashboard command subscriber failed to start');
      this.#commandSubscriber = undefined;
    }
  }

  /**
   * Verify dependencies before connecting to the gateway.
   *
   * In production every dependency is mandatory and any failure here is fatal,
   * so a bad deploy is caught at boot rather than mid-command.
   *
   * In development none of them block startup: the bot connects to Discord and
   * commands that need no infrastructure work immediately. Each unavailable
   * dependency is reported once, loudly, at startup.
   */
  async #verifyDependencies(): Promise<void> {
    // All three are checked so a single startup reports the complete picture,
    // rather than surfacing one missing service at a time.
    await this.#verifyRedis();
    this.#reportLavalink();
    await this.#verifyDatabase();
  }

  /**
   * Check PostgreSQL connectivity.
   *
   * `DATABASE_URL` stays mandatory in every environment and `this.prisma` is
   * always a real client — only *reachability* is tolerated in development.
   * Keeping the client non-optional means no feature has to null-check the
   * database; a command that queries while Postgres is down simply fails at
   * that point, which is a far better trade than making every future call site
   * handle an absent client.
   */
  async #verifyDatabase(): Promise<void> {
    if (await pingDatabase(this.prisma)) {
      this.logger.info('Database reachable');
      return;
    }

    const problem = 'Database is unreachable. Check DATABASE_URL and that PostgreSQL is running.';

    if (isProduction()) {
      throw new Error(problem);
    }

    this.logger.warn(
      `${problem} Continuing anyway — any command that reads or writes data will fail until it is running. Start it with \`pnpm run docker:up\`.`,
    );
  }

  async #verifyRedis(): Promise<void> {
    const production = isProduction();

    if (this.#redis === undefined) {
      // Unreachable in production: the env schema requires REDIS_URL there.
      this.logger.warn(
        'REDIS_URL is not set — caching and rate limiting are disabled. Set it before deploying.',
      );
      return;
    }

    try {
      await connectRedis(this.#redis);
      this.logger.info('Redis reachable');
    } catch (error) {
      if (production) throw error;

      // Development: drop the connection and carry on degraded. The underlying
      // socket error was already logged by the client's own error listener, so
      // only the consequence is reported here.
      this.logger.warn(
        'Redis is unreachable — continuing without it. Caching and rate limiting are disabled. Start it with `pnpm run docker:up`.',
      );
      await closeRedis(this.#redis).catch(() => {
        /* Already failing; nothing useful to do. */
      });
      this.#redis = undefined;
    }
  }

  /**
   * Log whether music playback will be available.
   *
   * Lavalink is only connected in Phase 4; this makes its absence visible at
   * startup rather than as a confusing failure on the first `/play`.
   */
  #reportLavalink(): void {
    const node = getLavalinkNode();

    if (node === undefined) {
      this.logger.warn(
        'Lavalink is not configured (LAVALINK_HOST / LAVALINK_PASSWORD) — music playback is disabled.',
      );
      return;
    }

    this.logger.info({ node: node.url, secure: node.secure }, 'Lavalink configured');
  }

  /**
   * Close every connection and exit cleanly. Idempotent — repeated signals
   * (e.g. double Ctrl-C) are ignored while a shutdown is already in progress.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    this.logger.info({ reason }, 'Shutting down');

    // Players first: they persist their queues and leave voice cleanly while
    // the gateway connection still exists.
    if (this.music !== undefined) {
      await this.music.destroyAll().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Music teardown failed during shutdown');
      });
    }

    // Prisma is deliberately absent: `getPrismaClient` is a process-wide
    // singleton, so a client disconnecting it would pull the database out from
    // under every other player in the fleet. The entry point owns it and
    // disconnects once, after everyone has stopped.
    const results = await Promise.allSettled([
      this.destroy(),
      this.#redis === undefined ? Promise.resolve() : closeRedis(this.#redis),
      this.#commandSubscriber === undefined ? Promise.resolve() : this.#commandSubscriber.stop(),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ err: result.reason }, 'Error during shutdown');
      }
    }

    this.logger.info({ player: this.identity.label }, 'Shutdown complete');
  }
}

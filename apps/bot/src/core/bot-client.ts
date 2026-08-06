/**
 * `BotClient` — the discord.js `Client` extended with this project's services.
 *
 * Everything long-lived (registries, database, Redis) hangs off the client so
 * handlers receive it explicitly through their context instead of importing
 * module-level singletons, which keeps them testable.
 *
 * Music (Shoukaku) is attached in Phase 4; the intents and structure needed for
 * it are already in place here.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPrismaClient, pingDatabase, type PrismaClient } from '@discord-music/database';
import {
  closeRedis,
  connectRedis,
  createRedisClient,
  type Redis,
} from '@discord-music/shared/redis';
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

import { getEnv, getLavalinkNode, isDevelopment, isProduction } from '../config/env.js';
import { getLogger, logger, type Logger } from '../lib/logger.js';
import { CommandRegistry } from './command-registry.js';
import { EventRegistry } from './event-registry.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

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

export class BotClient extends Client {
  readonly commands = new CommandRegistry();
  readonly events = new EventRegistry();
  readonly logger: Logger = logger;
  readonly prisma: PrismaClient;

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
  #shuttingDown = false;

  constructor() {
    super({
      intents: [...INTENTS],
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

    const env = getEnv();

    this.prisma = getPrismaClient({
      databaseUrl: env.DATABASE_URL,
      logQueries: isDevelopment() && env.LOG_LEVEL === 'trace',
    });

    this.#redis =
      env.REDIS_URL === undefined
        ? undefined
        : createRedisClient({ url: env.REDIS_URL, logger: getLogger('redis') });
  }

  /**
   * Load commands and events, verify dependencies, then connect to the gateway.
   *
   * Ordering matters: handlers must be attached before `login()` so no early
   * gateway event is dropped.
   */
  async start(): Promise<void> {
    const startedAt = Date.now();

    await this.commands.loadFrom(join(moduleDirectory, '..', 'commands'));
    await this.events.loadFrom(join(moduleDirectory, '..', 'events'));
    this.events.attach(this);

    await this.#verifyDependencies();

    await this.login(getEnv().BOT_TOKEN);
    this.logger.info({ durationMs: Date.now() - startedAt }, 'Bot startup complete');
  }

  /**
   * Verify dependencies before connecting to the gateway.
   *
   * PostgreSQL is required everywhere — the bot cannot function without it.
   * Redis and Lavalink are optional in development: an unreachable server logs
   * a warning and the corresponding features stay disabled, rather than
   * blocking local work. In production both are mandatory, so a failure here is
   * fatal and surfaces at deploy time instead of mid-command.
   */
  async #verifyDependencies(): Promise<void> {
    // Optional dependencies are checked first so their status is always visible,
    // even when the run ends on a missing required one. A developer gets the
    // whole picture in a single startup instead of fixing one thing at a time.
    await this.#verifyRedis();
    this.#reportLavalink();

    if (!(await pingDatabase(this.prisma))) {
      throw new Error(
        'Database is unreachable. Check DATABASE_URL and that PostgreSQL is running.',
      );
    }
    this.logger.info('Database reachable');
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

      // Development: drop the connection and carry on degraded.
      this.logger.warn(
        { err: error },
        'Redis is unreachable — continuing without it. Run `pnpm run docker:up` to enable caching and rate limiting.',
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

    const results = await Promise.allSettled([
      this.destroy(),
      this.#redis === undefined ? Promise.resolve() : closeRedis(this.#redis),
      this.prisma.$disconnect(),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ err: result.reason }, 'Error during shutdown');
      }
    }

    this.logger.info('Shutdown complete');
  }
}

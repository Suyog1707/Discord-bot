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
import { ConfigurationError } from '@discord-music/shared';
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
    await this.#connect();

    this.logger.info({ durationMs: Date.now() - startedAt }, 'Bot startup complete');
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
      await this.login(getEnv().BOT_TOKEN);
    } catch (error) {
      if (isInvalidTokenError(error)) {
        throw new ConfigurationError(
          'BOT_TOKEN is not a valid Discord bot token. Copy it from ' +
            'https://discord.com/developers/applications → your application → Bot → Reset Token, ' +
            'then set BOT_TOKEN in .env and re-run `pnpm run check:env`.',
          { cause: error },
        );
      }
      throw error;
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

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

import { getEnv, isDevelopment } from '../config/env.js';
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
  readonly redis: Redis;

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

    this.redis = createRedisClient({
      url: env.REDIS_URL,
      logger: getLogger('redis'),
    });
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

  /** Fail fast if Postgres or Redis is unreachable, rather than mid-command. */
  async #verifyDependencies(): Promise<void> {
    await connectRedis(this.redis);

    if (!(await pingDatabase(this.prisma))) {
      throw new Error(
        'Database is unreachable. Check DATABASE_URL and that PostgreSQL is running.',
      );
    }

    this.logger.info('Database and Redis reachable');
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
      closeRedis(this.redis),
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

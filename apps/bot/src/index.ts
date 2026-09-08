/**
 * Bot entry point.
 *
 * Responsibilities, in order:
 *   1. Install process-level safety nets before anything can throw.
 *   2. Construct and start the client (env is validated on first import).
 *   3. Shut down cleanly on SIGINT/SIGTERM so Docker and systemd restarts are graceful.
 */
import { getPrismaClient } from '@discord-music/database';
import { isAppError } from '@discord-music/shared';
import { RestError } from 'shoukaku';

import { getEnv } from './config/env.js';
import { BotClient } from './core/bot-client.js';
import { PlayerRouter, type RouterBot } from './music/player-router.js';
import { createInternalServer } from './server/index.js';
import { logger } from './lib/logger.js';

// Validate configuration before anything else, so a missing variable is
// reported immediately rather than after connections have been opened.
const env = getEnv();

/**
 * The fleet: the primary, then one client per extra player.
 *
 * Discord allows one voice connection per guild per token, so a server playing
 * in several channels at once needs one application per room. The primary is
 * the bot users talk to; the rest are headless players it can hand a channel
 * to. With `BOT_FLEET` unset this is a single client and the process behaves
 * exactly as it always has.
 */
const primary = new BotClient();
const workers = env.BOT_FLEET.map(
  (entry) =>
    new BotClient({
      token: entry.token,
      clientId: entry.clientId,
      label: entry.label,
      role: 'worker',
    }),
);
const fleet = [primary, ...workers];

/**
 * One router over every player, shared by all of them.
 *
 * It spans the fleet, so no single client can build it — and every client
 * needs it, because a command arriving at the primary may be about a room a
 * worker is serving. Clients whose Lavalink is unconfigured have no manager
 * and simply do not appear as players.
 */
const routerBots: readonly RouterBot[] = fleet.flatMap((client) => {
  const music = client.music;
  if (music === undefined) return [];
  return [
    {
      botId: client.identity.label,
      clientId: client.identity.clientId,
      music,
      isInGuild: (guildId: string) => client.guilds.cache.has(guildId),
    },
  ];
});
const router = new PlayerRouter(routerBots);
for (const client of fleet) client.router = router;

/**
 * One server per process, not per client.
 *
 * It answers for the container, and while several identities still share a
 * process only one of them can hold the port — so it is bound once, against
 * the primary. When each identity has a container of its own this is simply
 * the only client there is.
 */
const internal = createInternalServer(primary, env.BOT_INTERNAL_PORT);

/** Signals that should trigger a graceful shutdown. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Give in-flight work a moment to finish, but never hang a restart. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  const timeout = setTimeout(() => {
    logger.fatal({ reason }, 'Graceful shutdown timed out; forcing exit');
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not keep the event loop alive purely for this timer.
  timeout.unref();

  // Every client stops before the database does. Prisma is a process-wide
  // singleton, so a client disconnecting it on its own way out would pull the
  // pool from under the players still shutting down.
  // Stop answering before the bots go down, so nothing is told this
  // container is well while it is on its way out.
  await internal.stop().catch(() => undefined);
  await Promise.allSettled(fleet.map((client) => client.shutdown(reason)));
  await getPrismaClient({ databaseUrl: env.DATABASE_URL })
    .$disconnect()
    .catch((error: unknown) => {
      logger.warn({ err: error }, 'Database disconnect failed during shutdown');
    });

  clearTimeout(timeout);
  process.exit(exitCode);
}

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

/**
 * Whether an unhandled rejection is a transient upstream I/O failure rather
 * than a bug in this process.
 *
 * Shoukaku talks to Lavalink over REST from promises it never attaches a
 * handler to — `void player.sendServerUpdate(connection)` on every
 * `connectionUpdate`, for one — so a Lavalink request that times out during a
 * voice region change surfaces here and NOWHERE else: there is no call of
 * ours to wrap in a catch. Killing the process for it took the whole bot down
 * mid-song (observed: an `AbortError` from `sendServerUpdate` sixty seconds
 * after a voice-channel move), and it is the one failure the supervisor
 * restart cannot help with, because Lavalink reconnection is already handled
 * by the node's own retry path.
 *
 * The rejection is still reported in full — this decides whether it is worth
 * ending the process over, not whether to mention it.
 */
function isTransientUpstreamRejection(reason: unknown): boolean {
  if (reason instanceof RestError) return true;
  // `AbortError` specifically, and NOT `TimeoutError`. The two are not
  // interchangeable: a client library that aborts its own request through an
  // `AbortController` (shoukaku's REST timeout, discord.js's) produces
  // `AbortError`, while `AbortSignal.timeout` — which is what this codebase
  // uses for its own outbound calls — produces `TimeoutError`. Accepting
  // `TimeoutError` here would quietly downgrade exactly the failures that ARE
  // ours to fix.
  return (reason as { readonly name?: unknown } | null)?.name === 'AbortError';
}

// A rejection that reaches here is a bug: log it with full context, then exit so
// the supervisor restarts a known-good process rather than leaving a zombie.
// The exception is upstream I/O we were never given a chance to catch, which
// is logged just as loudly but must not stop the music.
process.on('unhandledRejection', (reason) => {
  if (isTransientUpstreamRejection(reason)) {
    logger.error(
      { err: reason },
      'Unhandled upstream rejection (Lavalink I/O); continuing without shutting down',
    );
    return;
  }
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

try {
  // Sequentially, so a bad token names itself instead of arriving in a pile of
  // concurrent failures — and so the primary is up before any player is.
  for (const client of fleet) {
    await client.start();
  }
  /**
   * Started after the gateway, so a healthcheck never sees a bot that is
   * listening but not yet connected. Not fatal yet — nothing depends on it
   * until siblings start calling each other, and refusing to run a working
   * bot over a port clash would be the worse trade today.
   */
  await internal.start().catch((error: unknown) => {
    logger.error(
      { err: error, port: env.BOT_INTERNAL_PORT },
      'Internal server could not bind; health checks and peer calls are unavailable',
    );
  });

  if (workers.length > 0) {
    logger.info(
      { players: workers.length + 1, labels: fleet.map((client) => client.identity.label) },
      'Fleet ready',
    );
  }
} catch (error) {
  // Configuration errors are the operator's problem, not a crash — print the
  // actionable message without a stack trace.
  if (isAppError(error) && error.code === 'CONFIGURATION') {
    logger.fatal(error.message);
  } else {
    logger.fatal({ err: error }, 'Failed to start bot');
  }
  await shutdown('startup-failure', 1);
}

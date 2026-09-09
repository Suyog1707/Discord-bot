/**
 * Bot entry point.
 *
 * Responsibilities, in order:
 *   1. Install process-level safety nets before anything can throw.
 *   2. Construct and start the client (env is validated on first import).
 *   3. Shut down cleanly on SIGINT/SIGTERM so Docker and systemd restarts are graceful.
 */
import { getPrismaClient } from '@discord-music/database';
import { isAppError, PLAYER_STATE_TTL_SECONDS } from '@discord-music/shared';
import { RestError } from 'shoukaku';

import { getEnv } from './config/env.js';
import { BotClient } from './core/bot-client.js';
import { PeerDirectory } from './music/peers.js';
import { PlayerRouter, type RouterBot } from './music/player-router.js';
import { createInternalServer } from './server/index.js';
import { HEALTHY, observeHealth, type WatchdogState } from './server/watchdog.js';
import { logger } from './lib/logger.js';

// Validate configuration before anything else, so a missing variable is
// reported immediately rather than after connections have been opened.
const env = getEnv();

/**
 * One container, one identity.
 *
 * Discord allows one voice connection per guild per token, so a server playing
 * in several channels at once needs one application per room — and each of
 * those now runs in its own container, so a crash takes down one room rather
 * than all of them. Which application this is comes entirely from env; nothing
 * here knows or cares how many others exist.
 */
const client = new BotClient({
  token: env.BOT_TOKEN,
  clientId: env.BOT_CLIENT_ID,
  label: env.BOT_LABEL,
  role: env.BOT_ROLE,
});

/**
 * The router knows one bot directly — this one.
 *
 * Everything else it needs is looked up: who else exists comes from the roster
 * in Postgres, what they are doing comes from their presence entries in Redis,
 * and reaching them is an HTTP call. So the shape a caller sees is the same
 * whether a room is in this process or three containers away.
 *
 * A client whose Lavalink is unconfigured has no manager and simply does not
 * appear as a player.
 */
const routerBots: readonly RouterBot[] =
  client.music === undefined
    ? []
    : [
        {
          botId: client.identity.label,
          clientId: client.identity.clientId,
          music: client.music,
          isInGuild: (guildId: string) => client.guilds.cache.has(guildId),
        },
      ];
/**
 * How this container makes itself findable.
 *
 * The presence entry it publishes is the only evidence an idle player exists
 * at all, since a bot holding no rooms leaves no trace in the room state — and
 * that is what the command router reads to decide who should take a channel.
 *
 * It no longer publishes an address. Nothing dials a sibling any more, so a
 * URL here would be a field that goes stale without anybody noticing.
 */
const peers = new PeerDirectory({
  redis: client.redis,
  selfBotId: client.identity.label,
  ttlSeconds: PLAYER_STATE_TTL_SECONDS,
});

const router = new PlayerRouter(routerBots, {
  peers,
  fleet: client.services.guilds,
  reclaimGraceMs: env.ROOM_RECLAIM_GRACE_MS,
});
client.router = router;
client.peers = peers;

/** Health for Docker, and the wedged-container check. */
const internal = createInternalServer(client, env.BOT_INTERNAL_PORT);

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
  await client.shutdown(reason);
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
  await client.start();
  /**
   * Quit if the gateway stays gone.
   *
   * Docker restarts a crash, not a stall — without this a wedged container
   * sits there looking healthy and silently plays nothing. `unref` so the
   * timer never keeps a shutting-down process alive.
   */
  let watchdog: WatchdogState = HEALTHY;
  setInterval(() => {
    const verdict = observeHealth(watchdog, {
      gatewayUp: client.isReady(),
      now: Date.now(),
      exitAfterMs: env.BOT_UNHEALTHY_EXIT_AFTER_MS,
    });
    if (verdict.kind === 'ok') {
      watchdog = verdict.next;
      return;
    }
    logger.fatal(
      { downForMs: verdict.downForMs, player: env.BOT_LABEL },
      'Gateway has been down too long; exiting so the container is restarted',
    );
    void shutdown('gateway-lost', 1);
  }, env.BOT_HEALTH_CHECK_MS).unref();

  /**
   * Started after the gateway, so a healthcheck never sees a bot that is
   * listening but not yet connected.
   *
   * Not fatal, though it now costs more than it used to: without it Docker
   * cannot tell whether this container is well, and siblings cannot hand it a
   * room. The bot it is already playing for is worth more than the rooms it
   * will not be offered, so it keeps running and says so loudly.
   */
  await internal.start().catch((error: unknown) => {
    logger.error(
      { err: error, port: env.BOT_INTERNAL_PORT },
      'Internal server could not bind; health checks and peer calls are unavailable',
    );
  });
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

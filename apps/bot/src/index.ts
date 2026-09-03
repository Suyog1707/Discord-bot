/**
 * Bot entry point.
 *
 * Responsibilities, in order:
 *   1. Install process-level safety nets before anything can throw.
 *   2. Construct and start the client (env is validated on first import).
 *   3. Shut down cleanly on SIGINT/SIGTERM so Docker and systemd restarts are graceful.
 */
import { isAppError } from '@discord-music/shared';
import { RestError } from 'shoukaku';

import { getEnv } from './config/env.js';
import { BotClient } from './core/bot-client.js';
import { logger } from './lib/logger.js';

// Validate configuration before anything else, so a missing variable is
// reported immediately rather than after connections have been opened.
getEnv();

const client = new BotClient();

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

  await client.shutdown(reason);
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

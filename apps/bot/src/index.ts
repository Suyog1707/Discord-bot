/**
 * Bot entry point.
 *
 * Responsibilities, in order:
 *   1. Install process-level safety nets before anything can throw.
 *   2. Construct and start the client (env is validated on first import).
 *   3. Shut down cleanly on SIGINT/SIGTERM so Docker and systemd restarts are graceful.
 */
import { isAppError } from '@discord-music/shared';

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

// A rejection that reaches here is a bug: log it with full context, then exit so
// the supervisor restarts a known-good process rather than leaving a zombie.
process.on('unhandledRejection', (reason) => {
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

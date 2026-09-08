/**
 * A container that is alive but wedged.
 *
 * Docker restarts containers that crash. It cannot see one whose process is
 * perfectly healthy but whose gateway connection has gone and not come back —
 * that bot looks fine, holds its rooms, and plays nothing. So it ends itself,
 * and the restart policy gives it a fresh connection.
 *
 * The rule is deliberately patient. discord.js reconnects on its own with its
 * own backoff, and a threshold shorter than that would restart a bot moments
 * before it recovered. Only a gateway that has been gone for a good while
 * counts — losing Lavalink or Postgres does not, because restarting would not
 * bring them back and would drop every room this container holds. That is the
 * same line `resolveBotHealth` draws, for the same reason.
 */

export interface WatchdogState {
  /** Epoch ms when the gateway was first seen down, or null while it is up. */
  readonly downSince: number | null;
}

export const HEALTHY: WatchdogState = { downSince: null };

export type WatchdogVerdict =
  | { readonly kind: 'ok'; readonly next: WatchdogState }
  | { readonly kind: 'exit'; readonly downForMs: number };

/**
 * Fold one observation into the watchdog's state.
 *
 * Pure, so "how long is too long" can be tested without waiting.
 *
 * @param exitAfterMs How long a gateway may stay down. Zero disables the check.
 */
export function observeHealth(
  state: WatchdogState,
  input: { readonly gatewayUp: boolean; readonly now: number; readonly exitAfterMs: number },
): WatchdogVerdict {
  if (input.gatewayUp) return { kind: 'ok', next: HEALTHY };
  if (input.exitAfterMs <= 0) return { kind: 'ok', next: state };

  // First time we have seen it down: start the clock rather than acting on a
  // single observation, which may be a reconnect in progress.
  const downSince = state.downSince ?? input.now;
  const downForMs = input.now - downSince;
  return downForMs >= input.exitAfterMs
    ? { kind: 'exit', downForMs }
    : { kind: 'ok', next: { downSince } };
}

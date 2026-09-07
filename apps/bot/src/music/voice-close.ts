/**
 * What to do when Discord closes a voice websocket.
 *
 * Lavalink forwards the close code from Discord's voice gateway verbatim.
 * Some of those codes end the session but leave the bot's *voice state*
 * standing, which is worse than a clean disconnect: audio stops, nothing
 * reconnects, and `getPlayer` keeps handing out a player whose voice
 * connection is dead. That is how a guild goes silent overnight.
 *
 * Pure, so the table can be read and tested without a gateway.
 */
export type VoiceCloseAction =
  /** The session is dead but the channel is still ours — rejoin it. */
  | 'reconnect'
  /** Someone else owns the outcome; do nothing here. */
  | 'ignore';

/**
 * Codes worth rejoining on.
 *
 * - `1006` — abnormal closure, no close frame. Usually a dropped connection.
 * - `4006` — "Session is no longer valid." Discord invalidated the voice
 *   session; the bot stays in the channel with nothing driving it.
 * - `4009` — session timed out.
 * - `4015` — the voice server crashed. The channel is unchanged.
 *
 * `4014` is deliberately absent. It means the bot was kicked, the channel was
 * deleted, or the voice server moved — Discord follows it with a voice state
 * update, and `voice-state-update.ts` already owns that outcome. Rejoining
 * would fight it. Every other code is a protocol or authentication fault that
 * a rejoin cannot fix, so it keeps today's behaviour: log and leave it.
 */
const RECONNECTABLE = new Set([1006, 4006, 4009, 4015]);

export function decideVoiceClose(code: number): VoiceCloseAction {
  return RECONNECTABLE.has(code) ? 'reconnect' : 'ignore';
}

/** What a guild's reconnect budget looks like between attempts. */
export interface ReconnectBudget {
  /** When the current window opened. */
  readonly startedAt: number;
  /** Attempts made inside it, this one included. */
  readonly attempts: number;
  /** Whether a rebuild is running right now. */
  readonly inFlight: boolean;
  /**
   * When the last rebuild came back healthy, or null if the last one failed
   * (or none has finished yet).
   *
   * The budget exists to stop a runaway loop, and a rebuild that worked and
   * then held is not a loop — it is the feature doing its job. Without this,
   * three drops on a flaky network inside a minute spent the budget and tore
   * down a session that was recovering perfectly well every time.
   */
  readonly recoveredAt: number | null;
}

export type ReconnectClaim =
  /** Go ahead, and store `next` as the new budget. */
  | { readonly decision: 'claimed'; readonly next: ReconnectBudget }
  /** A rebuild is already running; this close is an echo of its teardown. */
  | { readonly decision: 'busy' }
  /** Too many attempts too fast — rejoining is not working. */
  | { readonly decision: 'exhausted' };

/**
 * Decide whether a guild may rebuild its voice connection now.
 *
 * One at a time, and a bounded number inside a rolling window. A voice server
 * that closes the socket as fast as it opens would otherwise keep the bot
 * rejoining forever, and a reconnect loop is harder to recover from than no
 * player at all — `/play` fixes the latter.
 */
export function claimReconnect(
  current: ReconnectBudget | undefined,
  now: number,
  limits: {
    readonly maxAttempts: number;
    readonly windowMs: number;
    /**
     * How long a rebuilt session must survive before the drop that follows it
     * counts as a new incident rather than another turn of the same loop.
     */
    readonly stabilityMs: number;
  },
): ReconnectClaim {
  const fresh: ReconnectClaim = {
    decision: 'claimed',
    next: { startedAt: now, attempts: 1, inFlight: true, recoveredAt: null },
  };

  if (current === undefined || now - current.startedAt > limits.windowMs) return fresh;
  if (current.inFlight) return { decision: 'busy' };

  // The last rebuild worked and the session then ran for a while. Whatever
  // just happened is a new fault, not evidence that rejoining is failing.
  if (current.recoveredAt !== null && now - current.recoveredAt >= limits.stabilityMs) {
    return fresh;
  }

  if (current.attempts >= limits.maxAttempts) return { decision: 'exhausted' };

  return {
    decision: 'claimed',
    next: {
      startedAt: current.startedAt,
      attempts: current.attempts + 1,
      inFlight: true,
      recoveredAt: current.recoveredAt,
    },
  };
}

/**
 * Hand the budget back when a rebuild finishes.
 *
 * A recovery is stamped rather than forgotten: deleting the entry outright
 * would let a voice server that accepts every rejoin and then drops it
 * immediately loop forever, because each pass would start from a clean
 * budget. {@link claimReconnect} decides what the stamp is worth.
 */
export function releaseReconnect(
  current: ReconnectBudget | undefined,
  outcome: 'recovered' | 'failed',
  now: number,
): ReconnectBudget | undefined {
  if (current === undefined) return undefined;
  return {
    ...current,
    inFlight: false,
    recoveredAt: outcome === 'recovered' ? now : null,
  };
}

/**
 * Guilds whose window has closed and whose budget can be dropped.
 *
 * Budgets were only ever written, so a long-lived process accumulated one
 * entry per guild that had ever lost a voice socket. They are only meaningful
 * inside their window, so anything older is dead weight — swept on the next
 * claim rather than on a timer, because a map this small does not deserve one.
 */
export function expiredReconnects(
  entries: Iterable<readonly [string, ReconnectBudget]>,
  now: number,
  windowMs: number,
): readonly string[] {
  const stale: string[] = [];
  for (const [guildId, budget] of entries) {
    // Never drop a rebuild that is still running: its `finally` needs the entry.
    if (budget.inFlight) continue;
    if (now - budget.startedAt > windowMs) stale.push(guildId);
  }
  return stale;
}

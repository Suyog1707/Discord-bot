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
  limits: { readonly maxAttempts: number; readonly windowMs: number },
): ReconnectClaim {
  if (current === undefined || now - current.startedAt > limits.windowMs) {
    return { decision: 'claimed', next: { startedAt: now, attempts: 1, inFlight: true } };
  }
  if (current.inFlight) return { decision: 'busy' };
  if (current.attempts >= limits.maxAttempts) return { decision: 'exhausted' };

  return {
    decision: 'claimed',
    next: { startedAt: current.startedAt, attempts: current.attempts + 1, inFlight: true },
  };
}

/**
 * Helpers for the player SSE stream.
 *
 * Kept out of the route handler so the interesting decision — what a
 * late-joining client is allowed to be handed as its opening state — is a pure
 * function with tests, rather than logic buried inside a `ReadableStream`.
 */
import { decodePlayerEvent, type PlayerEvent } from '@discord-music/shared';

/**
 * Turn the snapshot retained in Redis into the first event of a stream.
 *
 * Returns `null` when there is nothing to send: no retained value, a malformed
 * one, or one belonging to a different guild. That last check is defence in
 * depth — the bot writes this value under a per-guild key, so a mismatch
 * should be impossible — but the stream is an authorization boundary, and it
 * must never relay another guild's player state even if keys were ever
 * mishandled upstream.
 *
 * On `null` the dashboard simply keeps whatever the page render gave it.
 */
export function initialPlayerEvent(
  raw: string | null,
  guildId: string,
  voiceChannelId: string,
): PlayerEvent | null {
  if (raw === null) return null;

  const event = decodePlayerEvent(raw);
  if (event === null) return null;

  // Both must match. The key already encodes the room, so a mismatch means
  // something is badly wrong; checking anyway keeps one room's state from
  // ever reaching another room's stream.
  return event.guildId === guildId && event.voiceChannelId === voiceChannelId ? event : null;
}

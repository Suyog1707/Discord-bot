/**
 * Reserving a bot for a room it has not joined yet.
 *
 * Joining voice is a handshake and a settle delay, and for that second or two
 * the chosen bot is holding no room and looks idle to anybody else deciding.
 * Two `/play`s a few milliseconds apart would otherwise be handed the same
 * bot, and the second would take the connection out from under the first.
 *
 * This is not mutual exclusion over a critical section — there is no
 * read-modify-write to protect. It is a short-lived *fact*, "somebody has
 * promised this bot to this channel", fed into a pure decision exactly as the
 * in-process claims map used to be. `SET NX` gives the one guarantee that
 * matters, that two allocators cannot both be told they own the same bot, in a
 * single round trip. No lock manager, no fencing tokens.
 *
 * It also does a second job that saves a whole mechanism. The bot that
 * receives the routed command runs its own allocation, and the router's claim
 * is visible to it as a claim on itself — so `allocateBot` answers `existing`
 * and the bot picks itself, rather than re-deciding and possibly choosing
 * somebody else. The router's decision is honoured without a second protocol
 * to say so.
 */
import { REDIS_NAMESPACE, redisKey } from '../constants/index.js';

/** Which channel a bot has been promised. Value: the voice channel id. */
export function botClaimKey(botId: string): string {
  return redisKey(REDIS_NAMESPACE.LOCK, 'bot', botId);
}

/** Who was promised a channel. Value: the bot id. */
export function roomClaimKey(guildId: string, voiceChannelId: string): string {
  return redisKey(REDIS_NAMESPACE.LOCK, 'room', guildId, voiceChannelId);
}

/**
 * How long a promise stands on its own.
 *
 * The owning bot deletes both claims once it is actually connected, so this is
 * the backstop rather than the normal path: it only matters when the bot never
 * arrives. Comfortably longer than a voice handshake and a settle, and shorter
 * than a person's patience.
 */
export const CLAIM_TTL_MS = 15_000;

/**
 * Player control messages sent from the dashboard to the bot over Redis
 * pub/sub. Defined here so publisher (apps/web) and subscriber (apps/bot)
 * validate the exact same schema — a malformed message is dropped, never
 * partially applied.
 *
 * Requires Redis; when it is absent (allowed in development) the dashboard
 * reports live control as unavailable instead of failing silently.
 */
import { z } from 'zod';

import { LIMITS, REDIS_NAMESPACE, redisKey } from '../constants/index.js';
import { snowflakeSchema } from '../validation/index.js';

/** Redis pub/sub channel for player commands. */
export const PLAYER_COMMAND_CHANNEL = redisKey(REDIS_NAMESPACE.PLAYER, 'commands');

export const playerCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('pause'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
  z.object({
    action: z.literal('resume'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
  z.object({
    action: z.literal('skip'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
  z.object({
    action: z.literal('stop'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
  z.object({
    action: z.literal('volume'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    volume: z.number().int().min(LIMITS.VOLUME_MIN).max(LIMITS.VOLUME_MAX),
  }),
  z.object({
    action: z.literal('shuffle'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
]);

export type PlayerCommand = z.infer<typeof playerCommandSchema>;
export type PlayerCommandAction = PlayerCommand['action'];

/** Serialise for publishing. */
export function encodePlayerCommand(command: PlayerCommand): string {
  return JSON.stringify(command);
}

/** Parse + validate an incoming message; null when malformed. */
export function decodePlayerCommand(raw: string): PlayerCommand | null {
  try {
    const result = playerCommandSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

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
  z.object({
    action: z.literal('previous'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
  }),
  z.object({
    action: z.literal('jump'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    /** 1-based position within the upcoming tracks, as shown in queue views. */
    position: z.number().int().min(1).max(LIMITS.QUEUE_MAX_TRACKS),
  }),
  z.object({
    action: z.literal('remove'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    /** 1-based position within the upcoming tracks. */
    position: z.number().int().min(1).max(LIMITS.QUEUE_MAX_TRACKS),
  }),
  z.object({
    action: z.literal('move'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    /** 1-based positions within the upcoming tracks. */
    from: z.number().int().min(1).max(LIMITS.QUEUE_MAX_TRACKS),
    to: z.number().int().min(1).max(LIMITS.QUEUE_MAX_TRACKS),
  }),
  z.object({
    action: z.literal('loop'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    mode: z.enum(['off', 'track', 'queue']),
  }),
  z.object({
    /**
     * "Not like this song" from the dashboard. The key is canonical
     * (`identityOf(author, title).key`, or the track's `sourceKey`) rather than
     * a provider id, because the dislike is about the recording — the bot has
     * to recognise the same song when it comes back from another source.
     */
    action: z.literal('dislike'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    trackKey: z.string().min(1),
    /**
     * Rejecting what is playing right now should also stop it playing. Default
     * true: the button sits next to the player, and leaving the song running
     * after a thumbs-down reads as the click having done nothing.
     */
    skipIfPlaying: z.boolean().default(true),
  }),
  z.object({
    /** Undo, from the preferences page. */
    action: z.literal('undislike'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    trackKey: z.string().min(1),
  }),
  z.object({
    /** Settings changed on the dashboard that a live player applies in place. */
    action: z.literal('sync-settings'),
    guildId: snowflakeSchema,
    issuedBy: snowflakeSchema,
    stayConnected: z.boolean().optional(),
    autoplayEnabled: z.boolean().optional(),
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

import 'server-only';

/**
 * Live player control: validate, authorize, then publish to the bot over
 * Redis pub/sub. The bot applies the command to the in-memory player and the
 * next queue persistence makes the change visible to `getServerDetail`.
 */
import {
  encodePlayerCommand,
  playerCommandSchema,
  PLAYER_COMMAND_CHANNEL,
  parseOrThrow,
  UpstreamError,
  z,
  type PlayerCommand,
} from '@discord-music/shared';

import { requireManagedGuild } from '@/lib/authz';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

/** Client-facing input: guildId comes from the URL, issuedBy from the session. */
export const playerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('shuffle') }),
  z.object({ action: z.literal('volume'), volume: z.number().int().min(0).max(200) }),
  z.object({ action: z.literal('previous') }),
  z.object({ action: z.literal('jump'), position: z.number().int().min(1) }),
  z.object({ action: z.literal('remove'), position: z.number().int().min(1) }),
  z.object({
    action: z.literal('move'),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
  }),
  z.object({ action: z.literal('loop'), mode: z.enum(['off', 'track', 'queue']) }),
]);

export type PlayerActionInput = z.infer<typeof playerActionSchema>;

export async function sendPlayerCommand(
  userId: string,
  userDiscordId: string,
  discordGuildId: string,
  input: unknown,
): Promise<PlayerCommand['action']> {
  await requireManagedGuild(userId, discordGuildId);

  const action = parseOrThrow(playerActionSchema, input);

  const redis = getRedis();
  if (redis === undefined) {
    throw new UpstreamError(
      'Live player control is unavailable: the realtime backend (Redis) is not configured.',
    );
  }

  // Re-validate the complete message against the shared schema — the bot will
  // do the same on receipt, so both ends agree on what is well-formed.
  const command = parseOrThrow(playerCommandSchema, {
    ...action,
    guildId: discordGuildId,
    issuedBy: userDiscordId,
  });

  const listeners = await redis.publish(PLAYER_COMMAND_CHANNEL, encodePlayerCommand(command));
  if (listeners === 0) {
    throw new UpstreamError('The bot is not listening for commands right now. Is it online?');
  }

  getLogger('player').info(
    { guildId: discordGuildId, action: command.action, issuedBy: userDiscordId },
    'Player command published',
  );

  return command.action;
}

import 'server-only';

/**
 * Live player control: validate, authorize, then publish to the bot over
 * Redis pub/sub. The bot applies the command to the in-memory player and the
 * next queue persistence makes the change visible to `getServerDetail`.
 */
import {
  encodePlayerCommand,
  playerBotIndexKey,
  playerBotKey,
  playerCommandSchema,
  playerRoomOwnerKey,
  PLAYER_COMMAND_CHANNEL,
  parseOrThrow,
  UpstreamError,
  z,
  type PlayerCommand,
} from '@discord-music/shared';

import { requireManagedGuild } from '@/lib/authz';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

/**
 * Client-facing input: guildId comes from the URL, issuedBy from the session,
 * and `voiceChannelId` names which of the server's rooms the command is for —
 * a dashboard open on one channel must not be able to touch another.
 */
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
  // Relayed for completeness: the dashboard's own "Not like" button posts to
  // /api/user/dislikes so the rejection is persisted first, but a client that
]);

export type PlayerActionInput = z.infer<typeof playerActionSchema>;

/**
 * Whether any container has checked in recently.
 *
 * Only used to word a failure, so it errs towards saying the bot is up: the
 * index of bot ids outlives the entries it points at — that is what lets a
 * container be found again after a restart — so membership alone proves
 * nothing and the entries themselves have to be read.
 */
async function anyPlayerOnline(): Promise<boolean> {
  const redis = getRedis();
  if (redis === undefined) return false;
  try {
    const ids = await redis.smembers(playerBotIndexKey());
    if (ids.length === 0) return false;
    const entries = await redis.mget(...ids.map((id) => playerBotKey(id)));
    return entries.some((entry) => entry !== null);
  } catch {
    return true;
  }
}

export async function sendPlayerCommand(
  userId: string,
  userDiscordId: string,
  discordGuildId: string,
  voiceChannelId: string,
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
    voiceChannelId,
    issuedBy: userDiscordId,
  });

  /**
   * Is anybody there to act on this?
   *
   * This used to count the subscribers the publish reached. That answered a
   * different question once every bot ran in one process: now several
   * containers subscribe to the same channel and only the one holding this
   * room will act, so a non-zero count says nothing about whether *that*
   * container is up.
   *
   * The room's owner claim is the honest check. It is written by whichever
   * container is in the channel and expires with it, so its presence means the
   * command has somewhere to land — and its absence tells the two failures
   * apart: nothing playing in this room, or no bot running at all.
   */
  const owner = await redis
    .get(playerRoomOwnerKey(discordGuildId, voiceChannelId))
    .catch(() => null);
  if (owner === null) {
    throw new UpstreamError(
      (await anyPlayerOnline())
        ? 'The bot is not in that voice channel any more. Use `/play` or `/join` to bring it back.'
        : 'The bot is not running right now.',
    );
  }

  await redis.publish(PLAYER_COMMAND_CHANNEL, encodePlayerCommand(command));

  getLogger('player').info(
    { guildId: discordGuildId, voiceChannelId, action: command.action, issuedBy: userDiscordId },
    'Player command published',
  );

  return command.action;
}

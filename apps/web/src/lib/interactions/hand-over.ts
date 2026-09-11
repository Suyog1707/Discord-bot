import 'server-only';

/**
 * Putting a command on a bot's queue — and, when the command promises that bot
 * a room, reserving it in the same breath.
 *
 * This used to be four round trips in a row: claim the bot, claim the room,
 * push, set the expiry. Each one is a wait between the person typing `/play`
 * and a bot hearing about it, so they go as one script now. The script also
 * closes a gap the four calls had: a push can no longer land for a bot whose
 * room claim was never written.
 */
import {
  botClaimKey,
  CLAIM_TTL_MS,
  interactionQueueKey,
  INTERACTION_QUEUE_TTL_SECONDS,
  roomClaimKey,
} from '@discord-music/shared';
import type { Redis } from '@discord-music/shared/redis';

/**
 * Claim the bot; if that worked, claim the room and hand over. If it did not,
 * answer with whoever holds the room, so the caller can follow them.
 *
 * KEYS: bot claim, room claim, the bot's queue.
 * ARGV: channel id, claim ttl (ms), bot id, envelope, queue ttl (s).
 */
export const CLAIM_AND_HAND_OVER_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
  redis.call('RPUSH', KEYS[3], ARGV[4])
  redis.call('EXPIRE', KEYS[3], ARGV[5])
  return 1
end
return redis.call('GET', KEYS[2])
`;

export type ClaimOutcome =
  | { readonly kind: 'won' }
  /** Somebody else has the bot. `holder` is who has this room, if anybody. */
  | { readonly kind: 'lost'; readonly holder: string | null };

export async function claimAndHandOver(
  redis: Redis,
  input: {
    readonly botId: string;
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly envelope: string;
  },
): Promise<ClaimOutcome> {
  const result = (await redis.eval(
    CLAIM_AND_HAND_OVER_SCRIPT,
    3,
    botClaimKey(input.botId),
    roomClaimKey(input.guildId, input.voiceChannelId),
    interactionQueueKey(input.botId),
    input.voiceChannelId,
    String(CLAIM_TTL_MS),
    input.botId,
    input.envelope,
    String(INTERACTION_QUEUE_TTL_SECONDS),
  )) as number | string | null;

  return result === 1
    ? { kind: 'won' }
    : { kind: 'lost', holder: typeof result === 'string' ? result : null };
}

/**
 * A list, not a channel.
 *
 * Publishing to a subscriber that is not there loses the message silently, and
 * a lost slash command is not silent to the person who typed it — they watch
 * "thinking…" until the interaction expires. A list holds the work across the
 * second or two a container spends restarting. The expiry is there so a
 * container that never comes back does not accumulate a queue of commands
 * nobody wants answered any more.
 */
export async function handOver(redis: Redis, botId: string, envelope: string): Promise<void> {
  const queue = interactionQueueKey(botId);
  const results = await redis
    .multi()
    .rpush(queue, envelope)
    .expire(queue, INTERACTION_QUEUE_TTL_SECONDS)
    .exec();

  const failure = results?.find(([error]) => error !== null)?.[0];
  if (results === null || failure != null) {
    throw failure ?? new Error('The hand-over transaction was discarded.');
  }
}

import 'server-only';

/**
 * Getting one command to the bot that should run it.
 *
 * Runs *after* Discord has already been told "thinking…", so nothing here is
 * racing the three-second acknowledgement window. That is the whole reason the
 * route answers first: this can take a Discord round trip, two Postgres reads
 * and a handful of Redis calls without anybody watching a spinner wonder
 * whether it worked.
 *
 * The decision itself is `routeInteraction`, which is pure. Everything in this
 * file is the I/O around it — reading the facts, reserving the answer, and
 * handing the work over.
 */
import {
  encodeInteractionEnvelope,
  interactionQueueKey,
  INTERACTION_QUEUE_TTL_SECONDS,
  routeInteraction,
  type DeferralMode,
  type RawInteraction,
} from '@discord-music/shared';

import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

import { editOriginalResponse, fetchVoiceChannelId } from './discord-api';
import { FleetUnavailableError, readFleet } from './fleet';

/** Discord's flag for a reply only the caller can see. */
const EPHEMERAL = 64;

export interface RouteCommandInput {
  readonly payload: RawInteraction;
  /** The visibility already sent to Discord, so the bot cannot disagree. */
  readonly deferral: DeferralMode;
}

/**
 * Decide, reserve, hand over — or say why not.
 *
 * Never throws. By the time this runs the user has a placeholder on screen, so
 * every failure has to end in something they can read; an exception escaping
 * here would leave that placeholder to time out fifteen minutes later.
 */
export async function routeCommand(input: RouteCommandInput): Promise<void> {
  const { payload, deferral } = input;
  const logger = getLogger('interactions');
  const commandName = commandNameOf(payload);

  try {
    const env = getEnv();
    const redis = getRedis();
    const guildId = payload.guild_id ?? null;
    const userId = callerIdOf(payload);

    if (redis === undefined) throw new FleetUnavailableError('REDIS_URL is not configured');

    /**
     * Where is the caller standing?
     *
     * Only asked when there is a guild and a token to ask with. A lookup that
     * fails answers `unknown`, and the router carries on as though they were
     * in no channel — the command itself then produces whatever message it
     * always produces, which is a better failure than guessing at a room.
     */
    let voiceChannelId: string | null = null;
    if (guildId !== null && userId !== null && env.BOT_TOKEN !== undefined) {
      const lookup = await fetchVoiceChannelId(env.BOT_TOKEN, guildId, userId);
      if (lookup.kind === 'in-voice') voiceChannelId = lookup.voiceChannelId;
    }

    if (guildId === null) {
      await reply(payload, 'This command can only be used in a server.', deferral);
      return;
    }

    const { fleet, ownerBotId } = await readFleet(guildId, voiceChannelId);
    const decision = routeInteraction({
      guildId,
      voiceChannelId,
      ownerBotId,
      fleet,
      now: Date.now(),
      reclaimGraceMs: env.ROOM_RECLAIM_GRACE_MS,
    });

    if (decision.kind === 'reply') {
      logger.info({ commandName, guildId, reason: 'refused' }, 'Command answered by the router');
      await reply(payload, decision.message, deferral);
      return;
    }

    const envelope = encodeInteractionEnvelope({
      payload,
      deferral,
      voiceChannelId: decision.voiceChannelId,
      routedAt: Date.now(),
    });

    /**
     * A list, not a channel.
     *
     * Publishing to a subscriber that is not there loses the message silently,
     * and a lost slash command is not silent to the person who typed it — they
     * watch "thinking…" until the interaction expires. A list holds the work
     * across the second or two a container spends restarting. The expiry is
     * there so a container that never comes back does not accumulate a queue
     * of commands nobody wants answered any more.
     */
    const queue = interactionQueueKey(decision.botId);
    await redis.rpush(queue, envelope);
    await redis.expire(queue, INTERACTION_QUEUE_TTL_SECONDS);

    logger.info(
      {
        commandName,
        guildId,
        voiceChannelId: decision.voiceChannelId,
        botId: decision.botId,
        reason: decision.reason,
      },
      'Command routed',
    );
  } catch (error) {
    const unavailable = error instanceof FleetUnavailableError;
    logger.error({ err: error, commandName, unavailable }, 'Routing failed');

    await reply(
      payload,
      unavailable
        ? "The bot's control channel is unavailable right now. Try again shortly."
        : 'Something went wrong routing that command. Try again shortly.',
      deferral,
    );
  }
}

/** Edit the placeholder the route already sent. */
async function reply(
  payload: RawInteraction,
  content: string,
  deferral: DeferralMode,
): Promise<void> {
  await editOriginalResponse(payload.application_id, payload.token, {
    content,
    // The flag has to match the deferral: visibility was fixed the moment the
    // placeholder went out and cannot be changed now.
    ...(deferral === 'ephemeral' ? { flags: EPHEMERAL } : {}),
  });
}

function commandNameOf(payload: RawInteraction): string {
  const data = (payload as { readonly data?: { readonly name?: unknown } }).data;
  return typeof data?.name === 'string' ? data.name : 'unknown';
}

/** In a guild Discord sends `member.user`; in a DM it sends `user`. */
function callerIdOf(payload: RawInteraction): string | null {
  const raw = payload as {
    readonly member?: { readonly user?: { readonly id?: unknown } };
    readonly user?: { readonly id?: unknown };
  };
  const id = raw.member?.user?.id ?? raw.user?.id;
  return typeof id === 'string' ? id : null;
}

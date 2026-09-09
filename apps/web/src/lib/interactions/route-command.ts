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
  botClaimKey,
  componentOwnerOf,
  CLAIM_TTL_MS,
  encodeInteractionEnvelope,
  interactionAckKey,
  interactionQueueKey,
  INTERACTION_QUEUE_TTL_SECONDS,
  roomClaimKey,
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

    /**
     * Reserve the bot before handing the work over.
     *
     * Only when the decision actually promised a room — an owner already in
     * the channel, or a command with no room at all, has nothing to reserve.
     *
     * A lost race is not retried into itself. The bot that won is the right
     * answer for this channel too, so the command follows it rather than
     * allocating a second bot for the same room.
     */
    let botId = decision.botId;
    if (decision.claims && decision.voiceChannelId !== null) {
      const won = await redis.set(
        botClaimKey(botId),
        decision.voiceChannelId,
        'PX',
        CLAIM_TTL_MS,
        'NX',
      );
      if (won === null) {
        const holder = await redis.get(roomClaimKey(guildId, decision.voiceChannelId));
        if (holder === null) {
          logger.info({ commandName, guildId, botId }, 'Lost the race for a player');
          await reply(
            payload,
            'Every player is busy in another channel right now. Try again shortly.',
            deferral,
          );
          return;
        }
        // Somebody claimed this very room a moment ago; follow them.
        botId = holder;
      } else {
        await redis.set(roomClaimKey(guildId, decision.voiceChannelId), botId, 'PX', CLAIM_TTL_MS);
      }
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
    const queue = interactionQueueKey(botId);
    await redis.rpush(queue, envelope);
    await redis.expire(queue, INTERACTION_QUEUE_TTL_SECONDS);

    logger.info(
      {
        commandName,
        guildId,
        voiceChannelId: decision.voiceChannelId,
        botId,
        reason: decision.reason,
      },
      'Command routed',
    );

    await confirmPickup(payload, botId, deferral);
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

/**
 * Make sure somebody actually took the work.
 *
 * Discord has already been told "thinking…", so a bot that never picks up
 * leaves a reply nothing will ever finish — the user watches a spinner until
 * the interaction expires fifteen minutes later. That is a failure the gateway
 * path could not produce, so it needs an answer here rather than a shrug.
 *
 * Two reads, not a poll. The bot writes its ack before doing any work, so it
 * appears within milliseconds of pickup; the second read exists only to cover
 * a container that was mid-restart when the work arrived.
 */
async function confirmPickup(
  payload: RawInteraction,
  botId: string,
  deferral: DeferralMode,
): Promise<void> {
  const redis = getRedis();
  if (redis === undefined) return;

  const key = interactionAckKey(payload.id);
  for (const delayMs of PICKUP_CHECKS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const picked = await redis.get(key).catch(() => 'unknown');
    if (picked !== null) return;
  }

  getLogger('interactions').error({ botId, interactionId: payload.id }, 'Nobody picked that up');
  await reply(payload, `**${botId}** did not respond. Try again in a moment.`, deferral);
}

/**
 * When to look, measured from the publish.
 *
 * Bounded on purpose: this runs inside a metered function, and a retry loop
 * here would be a job queue nobody designed.
 */
const PICKUP_CHECKS_MS = [400, 900] as const;

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

/**
 * Send a button back to the bot whose message it is on.
 *
 * A component is not routed by where the caller is standing — it belongs to a
 * specific message, and only the bot that posted that message has the state
 * behind it: the player the controller is showing, or the collector that
 * `/spotify` left open. `message.author.id` is that bot's user id, which for a
 * bot is also its application id, so the roster maps it straight back.
 */
export async function routeComponent(payload: RawInteraction): Promise<void> {
  const logger = getLogger('interactions');
  const guildId = payload.guild_id ?? null;
  const authorId = messageAuthorIdOf(payload);

  try {
    const redis = getRedis();
    if (redis === undefined || guildId === null || authorId === null) {
      logger.warn({ guildId, authorId }, 'Component interaction could not be routed');
      return;
    }

    const { fleet } = await readFleet(guildId, null);

    /**
     * Two ways to know whose button this is.
     *
     * The controller is posted by the bot that owns the room, so the message's
     * author names it. Anything a *command* posted cannot be identified that
     * way — every command reply goes out under the command application, so
     * they all look alike — and those components carry the bot's name in their
     * own id instead. The tag wins where it exists.
     */
    const tagged = componentOwnerOf(customIdOf(payload) ?? '');
    const botId =
      tagged !== null && fleet.clientIds.has(tagged)
        ? tagged
        : [...fleet.clientIds].find(([, clientId]) => clientId === authorId)?.[0];

    if (botId === undefined) {
      logger.warn({ authorId, guildId }, 'Nothing in the roster owns that component');
      return;
    }

    const queue = interactionQueueKey(botId);
    await redis.rpush(
      queue,
      encodeInteractionEnvelope({
        payload,
        // A component is answered with a deferred *update*; the mode is
        // carried only so the envelope has one shape.
        deferral: 'ephemeral',
        voiceChannelId: null,
        routedAt: Date.now(),
      }),
    );
    await redis.expire(queue, INTERACTION_QUEUE_TTL_SECONDS);

    logger.info({ botId, guildId, customId: customIdOf(payload) }, 'Component routed');
  } catch (error) {
    logger.error({ err: error, guildId }, 'Component routing failed');
  }
}

/** Who posted the message this component sits on. */
function messageAuthorIdOf(payload: RawInteraction): string | null {
  const id = (payload as { readonly message?: { readonly author?: { readonly id?: unknown } } })
    .message?.author?.id;
  return typeof id === 'string' ? id : null;
}

function customIdOf(payload: RawInteraction): string | undefined {
  const id = (payload as { readonly data?: { readonly custom_id?: unknown } }).data?.custom_id;
  return typeof id === 'string' ? id : undefined;
}

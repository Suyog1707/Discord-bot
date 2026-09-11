import 'server-only';

/**
 * Getting one command to the bot that should run it.
 *
 * Runs *after* Discord has already been told "thinking…", so nothing here is
 * racing the three-second acknowledgement window. That is the whole reason the
 * route answers first. Answering first does not make this free: the person is
 * still waiting for a bot to join, so the work is kept to one Discord call and
 * three Redis round trips, sent side by side wherever they do not depend on
 * each other.
 *
 * The decision itself is `routeInteraction`, which is pure. Everything in this
 * file is the I/O around it — reading the facts, reserving the answer, and
 * handing the work over.
 */
import {
  componentOwnerOf,
  encodeInteractionEnvelope,
  interactionAckKey,
  routeInteraction,
  type DeferralMode,
  type FleetView,
  type RawInteraction,
  type RoutingDecision,
} from '@discord-music/shared';

import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getReadyRedis } from '@/lib/redis';

import { editOriginalResponse, fetchVoiceChannelId } from './discord-api';
import { fleetFromDatabase, FleetUnavailableError, readFleet, readFleetIds } from './fleet';
import { claimAndHandOver, handOver } from './hand-over';

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
    const redis = await getReadyRedis();
    const guildId = payload.guild_id ?? null;
    const userId = callerIdOf(payload);

    if (redis === undefined) throw new FleetUnavailableError('REDIS_URL is not configured');

    /**
     * Where is the caller standing — asked at the same moment as the fleet
     * index, because neither answer waits on the other.
     *
     * Only asked when there is a guild and a token to ask with. A lookup that
     * fails answers `unknown`, and the router carries on as though they were
     * in no channel — the command itself then produces whatever message it
     * always produces, which is a better failure than guessing at a room.
     */
    const [lookup, ids] = await Promise.all([
      guildId !== null && userId !== null && env.BOT_TOKEN !== undefined
        ? fetchVoiceChannelId(env.BOT_TOKEN, guildId, userId)
        : Promise.resolve(null),
      guildId === null ? Promise.resolve([]) : readFleetIds(),
    ]);
    const voiceChannelId = lookup?.kind === 'in-voice' ? lookup.voiceChannelId : null;

    if (guildId === null) {
      await reply(payload, 'This command can only be used in a server.', deferral);
      return;
    }

    const snapshot = await readFleet(guildId, voiceChannelId, ids);
    const decide = (fleet: FleetView): RoutingDecision =>
      routeInteraction({
        guildId,
        voiceChannelId,
        ownerBotId: snapshot.ownerBotId,
        fleet,
        now: Date.now(),
        reclaimGraceMs: env.ROOM_RECLAIM_GRACE_MS,
      });
    let decision = decide(snapshot.fleet);

    /**
     * A refusal gets a second look, with the full roster.
     *
     * The fast read only sees bots that are running, which is all allocation
     * can hand out — but "add another bot" may need to name one that is
     * stopped, and only Postgres knows those. Refusals are rare, which is
     * exactly why the query lives here and not on every command.
     *
     * Only the wording is taken from it. Postgres can lag the gateway on who
     * is in a server, and dispatching on its word could send a command to a
     * bot that has just been removed.
     */
    if (decision.kind === 'reply' && voiceChannelId !== null) {
      const fuller = decide(await fleetFromDatabase(guildId, snapshot.presence));
      if (fuller.kind === 'reply') decision = fuller;
    }

    if (decision.kind === 'reply') {
      logger.info({ commandName, guildId, reason: 'refused' }, 'Command answered by the router');
      await reply(payload, decision.message, deferral);
      return;
    }

    /**
     * Reserve the bot and hand the work over, in one round trip.
     *
     * Only when the decision actually promised a room — an owner already in
     * the channel, or a command with no room at all, has nothing to reserve.
     *
     * A lost race is not retried into itself. The bot that won is the right
     * answer for this channel too, so the command follows it rather than
     * allocating a second bot for the same room.
     */
    const envelope = encodeInteractionEnvelope({
      payload,
      deferral,
      voiceChannelId: decision.voiceChannelId,
      routedAt: Date.now(),
    });

    let botId = decision.botId;
    if (decision.claims && decision.voiceChannelId !== null) {
      const claim = await claimAndHandOver(redis, {
        botId,
        guildId,
        voiceChannelId: decision.voiceChannelId,
        envelope,
      });
      if (claim.kind === 'lost') {
        if (claim.holder === null) {
          logger.info({ commandName, guildId, botId }, 'Lost the race for a player');
          await reply(
            payload,
            'Every player is busy in another channel right now. Try again shortly.',
            deferral,
          );
          return;
        }
        // Somebody claimed this very room a moment ago; follow them.
        botId = claim.holder;
        await handOver(redis, botId, envelope);
      }
    } else {
      await handOver(redis, botId, envelope);
    }

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
  const redis = await getReadyRedis().catch(() => undefined);
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
    const redis = await getReadyRedis();
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

    await handOver(
      redis,
      botId,
      encodeInteractionEnvelope({
        payload,
        // A component is answered with a deferred *update*; the mode is
        // carried only so the envelope has one shape.
        deferral: 'ephemeral',
        voiceChannelId: null,
        routedAt: Date.now(),
      }),
    );

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

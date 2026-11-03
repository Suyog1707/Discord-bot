/**
 * Routing on the primary's own gateway.
 *
 * With Discord's Interactions Endpoint URL cleared, every slash command
 * arrives on main's websocket within milliseconds, instead of through Vercel
 * and a Tailscale Funnel relay that measured 2.8–40 s and blew Discord's
 * three-second window. Main then does what the web router does
 * (apps/web/src/lib/interactions/route-command.ts): say "thinking…" at once,
 * pick the bot for the caller's voice channel, and put the command on that
 * bot's Redis queue.
 *
 * Main's own queue is no exception. A command main is going to run itself
 * still goes through it, so there is exactly one execution path for a routed
 * command — `InteractionSubscriber` rehydrates, marks it routed and
 * dispatches — whoever runs it. The alternative, running inline when main wins
 * the pick, would be a second path that has to be kept identical by hand.
 *
 * Anything this cannot route runs locally, as it did before routing existed:
 * no Redis, no captured payload, an unknown command, a DM. That degrades to
 * single-room play rather than to nothing.
 *
 * The decision is `routeInteraction`, which is pure and shared with the web
 * router. Everything here is the I/O around it, with the I/O injected so the
 * ordering guarantees can be tested without Discord or Redis.
 */
import {
  componentOwnerOf,
  encodeInteractionEnvelope,
  interactionAckKey,
  routeInteraction,
  type BotPresence,
  type FleetView,
  type RoutingDecision,
} from '@discord-music/shared';
import { claimAndHandOver, handOver, readBotIds, type Redis } from '@discord-music/shared/redis';
import type { ChatInputCommandInteraction, MessageComponentInteraction } from 'discord.js';

import { getEnv } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';
import { resolveDeferral, subcommandOf } from './command.js';
import { dispatchChatInputCommand } from './dispatch-command.js';
import {
  FleetUnavailableError,
  fleetFromRoster,
  readGatewayFleet,
  type FleetSnapshot,
} from './gateway-fleet.js';
import { acknowledge, isDeadInteraction } from './interaction-response.js';

/**
 * When to look for the pickup acknowledgement, measured from the hand-over.
 *
 * Bounded on purpose, and identical to the web router's: this is two reads,
 * not a poll. The bot writes its ack before doing any work, so it appears
 * within milliseconds; the second read covers a container that was
 * mid-restart when the work arrived.
 */
export const PICKUP_CHECKS_MS = [400, 900] as const;

/** Everything with a side effect, so a test can drive the router without any. */
export interface GatewayRouterDeps {
  readonly readFleet: (
    redis: Redis,
    guildId: string,
    voiceChannelId: string | null,
  ) => Promise<FleetSnapshot>;
  readonly fleetFromDatabase: (
    guildId: string,
    presence: readonly BotPresence[],
  ) => Promise<FleetView>;
  readonly readBotIds: (redis: Redis) => Promise<readonly string[]>;
  readonly claimAndHandOver: typeof claimAndHandOver;
  readonly handOver: typeof handOver;
  readonly reclaimGraceMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export function gatewayRouterDeps(client: BotClient): GatewayRouterDeps {
  const roster = client.services.guilds;
  return {
    readFleet: (redis, guildId, voiceChannelId) =>
      readGatewayFleet(redis, roster, guildId, voiceChannelId),
    fleetFromDatabase: (guildId, presence) => fleetFromRoster(roster, guildId, presence),
    readBotIds,
    claimAndHandOver,
    handOver,
    reclaimGraceMs: getEnv().ROOM_RECLAIM_GRACE_MS,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: Date.now,
  };
}

/** Redis, but only when it can be used right now. */
function readyRedis(client: BotClient): Redis | undefined {
  const redis = client.redis;
  return redis?.status === 'ready' ? redis : undefined;
}

/**
 * Acknowledge, decide, hand over — or run it here when it cannot be routed.
 *
 * Never throws once the interaction is acknowledged. By then the user has a
 * placeholder on screen, so every failure has to end in something they can
 * read; an exception escaping would leave that placeholder to time out.
 */
export async function routeGatewayCommand(
  client: BotClient,
  interaction: ChatInputCommandInteraction,
  logger: Logger,
  deps?: GatewayRouterDeps,
): Promise<void> {
  if (client.identity.role !== 'primary') {
    await dispatchChatInputCommand(client, interaction, logger);
    return;
  }

  // Always taken, even when it will not be used, so nothing can leak.
  const raw = client.rawInteractions.take(interaction.id);

  const command = client.commands.get(interaction.commandName);
  const { guildId, guild } = interaction;
  if (command === undefined || guildId === null || guild === null) {
    await dispatchChatInputCommand(client, interaction, logger);
    return;
  }

  const redis = readyRedis(client);
  // The subscriber check is here, before the acknowledgement, the claim and
  // every hand-over, so nothing is ever pushed to main's own queue when
  // nothing is reading it. Running locally is the single-room fallback.
  if (redis === undefined || raw === undefined || !client.interactionSubscriberRunning) {
    let reason = 'subscriber-not-running';
    if (redis === undefined) reason = 'redis-unavailable';
    else if (raw === undefined) reason = 'no-raw-payload';
    logger.warn(
      {
        commandName: interaction.commandName,
        reason,
      },
      'Cannot route over the gateway; running the command locally',
    );
    await dispatchChatInputCommand(client, interaction, logger);
    return;
  }

  /**
   * Acknowledge before any I/O at all.
   *
   * This is the entire point of the gateway path: the three-second window is
   * the thing being protected, and everything after this line reads Redis.
   */
  const router = deps ?? gatewayRouterDeps(client);
  const deferral = resolveDeferral(command.deferral, subcommandOf(interaction));
  const alive = await acknowledge(interaction, deferral, logger);
  if (!alive) return;
  const ackMs = router.now() - interaction.createdTimestamp;

  const commandName = interaction.commandName;
  try {
    // Main's own voice-state cache: no REST call, which is what the web
    // router has to pay for.
    const voiceChannelId = guild.voiceStates.cache.get(interaction.user.id)?.channelId ?? null;

    const snapshot = await router.readFleet(redis, guildId, voiceChannelId);
    const decide = (fleet: FleetView): RoutingDecision =>
      routeInteraction({
        guildId,
        voiceChannelId,
        ownerBotId: snapshot.ownerBotId,
        fleet,
        now: router.now(),
        reclaimGraceMs: router.reclaimGraceMs,
      });
    let decision = decide(snapshot.fleet);

    // A refusal gets a second look with the full roster, for the same reason
    // as on the web router: only the roster can name a stopped player to
    // invite, and refusals are rare enough to afford the query. Only the
    // wording is taken from it.
    if (decision.kind === 'reply' && voiceChannelId !== null) {
      const fuller = decide(await router.fleetFromDatabase(guildId, snapshot.presence));
      if (fuller.kind === 'reply') decision = fuller;
    }

    if (decision.kind === 'reply') {
      logger.info({ commandName, guildId, reason: 'refused' }, 'Command answered by the router');
      await reply(interaction, decision.message, logger);
      return;
    }

    const envelope = encodeInteractionEnvelope({
      payload: raw,
      deferral,
      voiceChannelId: decision.voiceChannelId,
      routedAt: router.now(),
    });

    // Reserve the bot and hand over in one round trip when the decision
    // promised a room. A lost race is followed rather than retried: whoever
    // won is the right answer for this channel too.
    let botId = decision.botId;
    if (decision.claims && decision.voiceChannelId !== null) {
      const claim = await router.claimAndHandOver(redis, {
        botId,
        guildId,
        voiceChannelId: decision.voiceChannelId,
        envelope,
      });
      if (claim.kind === 'lost') {
        if (claim.holder === null) {
          logger.info({ commandName, guildId, botId }, 'Lost the race for a player');
          await reply(
            interaction,
            'Every player is busy in another channel right now. Try again shortly.',
            logger,
          );
          return;
        }
        botId = claim.holder;
        await router.handOver(redis, botId, envelope);
      }
    } else {
      await router.handOver(redis, botId, envelope);
    }

    logger.info(
      {
        commandName,
        guildId,
        voiceChannelId: decision.voiceChannelId,
        botId,
        reason: decision.reason,
        via: 'gateway',
        ackMs,
        handOverMs: router.now() - interaction.createdTimestamp,
      },
      'Command routed',
    );

    await confirmPickup(redis, interaction, botId, router, logger);
  } catch (error) {
    const unavailable = error instanceof FleetUnavailableError;
    logger.error({ err: error, commandName, unavailable }, 'Routing failed');
    await reply(
      interaction,
      unavailable
        ? "The bot's control channel is unavailable right now. Try again shortly."
        : 'Something went wrong routing that command. Try again shortly.',
      logger,
    );
  }
}

/**
 * Make sure somebody actually took the work.
 *
 * The placeholder is already on screen, so a bot that never picks up leaves a
 * spinner nothing will finish. Same two reads as the web router.
 */
async function confirmPickup(
  redis: Redis,
  interaction: ChatInputCommandInteraction,
  botId: string,
  router: GatewayRouterDeps,
  logger: Logger,
): Promise<void> {
  const key = interactionAckKey(interaction.id);
  for (const delayMs of PICKUP_CHECKS_MS) {
    await router.sleep(delayMs);
    const picked = await redis.get(key).catch(() => 'unknown');
    if (picked !== null) return;
  }

  logger.error({ botId, interactionId: interaction.id }, 'Nobody picked that up');
  await reply(interaction, `**${botId}** did not respond. Try again in a moment.`, logger);
}

/**
 * Edit the placeholder. Never throws.
 *
 * No flags: the deferral already fixed the visibility, and it cannot be
 * changed now.
 */
async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.editReply({ content });
  } catch (error) {
    logger.error({ err: error, interactionId: interaction.id }, 'Could not edit the placeholder');
  }
}

/**
 * Send a button to the bot whose message it is on.
 *
 * Only components carrying another bot's tag are taken (`/spotify` and the
 * like, whose collectors live in that bot's process). Everything else —
 * including the controller's own buttons — is left to local handling, as
 * before. Returns whether the interaction was taken.
 */
export async function routeGatewayComponent(
  client: BotClient,
  interaction: MessageComponentInteraction,
  logger: Logger,
  deps?: GatewayRouterDeps,
): Promise<boolean> {
  if (client.identity.role !== 'primary') return false;

  const raw = client.rawInteractions.take(interaction.id);

  // A routed click that the subscriber re-emits here arrives already
  // deferred. Routing it again would bounce it between queues forever.
  if (interaction.deferred || interaction.replied) return false;

  const tag = componentOwnerOf(interaction.customId);
  if (tag === null || tag === client.identity.label) return false;

  const redis = readyRedis(client);
  if (raw === undefined || redis === undefined) {
    logger.warn(
      { customId: interaction.customId, owner: tag },
      'Component could not be routed; handling it locally',
    );
    return false;
  }

  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (isDeadInteraction(error)) {
      logger.warn({ owner: tag }, 'Component expired before it could be acknowledged');
    } else {
      logger.error({ err: error, owner: tag }, 'Component acknowledgement failed');
    }
    return true;
  }

  const router = deps ?? gatewayRouterDeps(client);
  try {
    const ids = await router.readBotIds(redis);
    if (!ids.includes(tag)) {
      logger.warn({ owner: tag }, 'Nothing in the fleet owns that component');
      return true;
    }

    await router.handOver(
      redis,
      tag,
      encodeInteractionEnvelope({
        payload: raw,
        // A component is answered with a deferred *update*; the mode is
        // carried only so the envelope has one shape.
        deferral: 'ephemeral',
        voiceChannelId: null,
        routedAt: router.now(),
      }),
    );
    logger.info(
      { botId: tag, guildId: interaction.guildId, customId: interaction.customId, via: 'gateway' },
      'Component routed',
    );
  } catch (error) {
    logger.error({ err: error, owner: tag }, 'Component routing failed');
  }
  return true;
}

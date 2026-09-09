/**
 * Which bot should run this command.
 *
 * The whole of the routing decision, as a pure function — so "seven players,
 * one already in the caller's channel, two idle, one dead" is a row in a test
 * rather than a fleet to reproduce. The shell around it does the Redis reads,
 * the claim and the publish; this decides, exactly as `allocateBot` decides
 * without knowing anything about the map that reserves its answer.
 *
 * The order of the rules is the design:
 *
 *   1. Somebody is already in the caller's channel — it is theirs. This is
 *      almost every command: /skip, /pause, /queue, everything mid-session.
 *   2. Nobody is, and the caller is in a channel — allocate one, so a second
 *      person playing in a second channel gets a second bot rather than a
 *      handover.
 *   3. The caller is in no channel at all — send it to the primary anyway and
 *      let the command say what it thinks. There is deliberately no table of
 *      which commands need a voice channel: the commands already answer that
 *      question themselves, and a second copy of the answer would drift.
 */
import { allocateBot, describeAllocation, type FleetView } from '../fleet/index.js';

export interface RouteInteractionInput {
  /** Null in a DM, where there is no fleet and no room. */
  readonly guildId: string | null;
  /** The caller's own voice channel, or null when they are not in one. */
  readonly voiceChannelId: string | null;
  /** Who already holds that channel, from the owner claim. */
  readonly ownerBotId: string | null;
  /** The fleet, with any outstanding claims already folded in. */
  readonly fleet: FleetView;
  readonly now: number;
  readonly reclaimGraceMs: number;
}

export type RoutingDecision =
  | {
      readonly kind: 'dispatch';
      readonly botId: string;
      /** The room this is about, or null when the caller is in no channel. */
      readonly voiceChannelId: string | null;
      readonly reason: 'owner' | 'existing' | 'free' | 'reclaim' | 'fallback';
      /** Whether the router promised this bot a room it has not joined yet. */
      readonly claims: boolean;
    }
  /** Answered by the router itself; no bot is involved. */
  | { readonly kind: 'reply'; readonly message: string };

export function routeInteraction(input: RouteInteractionInput): RoutingDecision {
  const { guildId, voiceChannelId, fleet } = input;

  if (guildId === null) {
    return { kind: 'reply', message: 'This command can only be used in a server.' };
  }

  /**
   * The owner claim outlives the container that wrote it — it expires on a
   * timer, not on a crash — so a bot named there but missing from the fleet is
   * gone, and the room is free. Falling through to allocation is what lets a
   * channel recover from a player that died without saying goodbye.
   */
  if (input.ownerBotId !== null && voiceChannelId !== null) {
    const owner = fleet.members.find((member) => member.botId === input.ownerBotId);
    if (owner !== undefined) {
      return {
        kind: 'dispatch',
        botId: owner.botId,
        voiceChannelId,
        reason: 'owner',
        claims: false,
      };
    }
  }

  /**
   * Not in a voice channel. Every command that needs one already refuses on
   * its own — this path exists so `/help`, `/settings` and `/history` keep
   * working, and so a `/play` typed outside voice gets the same message it has
   * always got, from the same place.
   */
  if (voiceChannelId === null) {
    const fallback = fallbackBot(fleet);
    return fallback === undefined
      ? { kind: 'reply', message: 'No player is available right now. Try again shortly.' }
      : {
          kind: 'dispatch',
          botId: fallback,
          voiceChannelId: null,
          reason: 'fallback',
          claims: false,
        };
  }

  const allocation = allocateBot({
    voiceChannelId,
    fleet: fleet.members,
    now: input.now,
    reclaimGraceMs: input.reclaimGraceMs,
    hasUninvitedPlayers: fleet.uninvited.length > 0,
  });

  if (allocation.kind === 'invite' || allocation.kind === 'full') {
    return { kind: 'reply', message: describeAllocation(allocation, fleet, guildId) };
  }

  return {
    kind: 'dispatch',
    botId: allocation.botId,
    voiceChannelId,
    reason: allocation.kind,
    // `existing` means the bot is already there or already promised the room,
    // so there is nothing left to reserve.
    claims: allocation.kind !== 'existing',
  };
}

/**
 * Where a command with no room goes.
 *
 * The primary first, because it is the bot people think of as *the* bot and
 * the one most likely to be in every server. Any live member of the guild will
 * do otherwise — what matters is that it is actually in the guild, since the
 * command reads the guild and the member out of that bot's own cache.
 */
function fallbackBot(fleet: FleetView): string | undefined {
  if (fleet.primaryBotId !== undefined) return fleet.primaryBotId;
  return fleet.members.find((member) => member.inGuild)?.botId;
}

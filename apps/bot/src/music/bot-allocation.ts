/**
 * Which player bot should serve a voice channel.
 *
 * One Discord token holds one voice connection per server, so a server playing
 * in several channels at once is really several applications each playing in
 * one. Deciding *which* of them takes a room is the whole of the multi-room
 * feature that is not plumbing, so it lives here on its own: pure, and
 * testable without a gateway, a guild or a player — the same shape as
 * `channel-handover.ts` and `voice-close.ts`.
 *
 * The order of the rules is the design:
 *
 *   1. A bot already on this room keeps it. Anything else would fight itself.
 *   2. A bot doing nothing here is better than taking one off another room.
 *   3. Only then, reclaim — and only a room that is genuinely finished with.
 *   4. Out of bots, but the server has not invited them all: ask for one.
 *   5. Out of bots entirely: say so.
 */

/** What one bot in the fleet is doing in the guild being asked about. */
export interface FleetMember {
  readonly botId: string;
  /**
   * Whether this bot is a member of the guild at all.
   *
   * Players are invited on demand, so most servers have only some of them. A
   * bot that is not in the server cannot serve it, however idle it looks.
   */
  readonly inGuild: boolean;
  /** The room it is serving here, or null when it holds none. */
  readonly serving: {
    readonly voiceChannelId: string;
    readonly listenersPresent: boolean;
    /** 24/7: this room is empty on purpose and is never taken. */
    readonly stayConnected: boolean;
    /** Epoch ms since the room emptied, null while people are in it. */
    readonly emptySince: number | null;
  } | null;
  /**
   * A room this bot has been promised but has not finished joining.
   *
   * Joining takes a voice handshake and a settle delay, during which the bot
   * has no player and looks free. Two `/play`s a few milliseconds apart would
   * otherwise both be handed the same bot, and the second would steal the
   * first's connection out from under it.
   */
  readonly claimedFor: string | null;
}

export type Allocation =
  /** Already on this room — reuse it. */
  | { readonly kind: 'existing'; readonly botId: string }
  /** Idle in this guild; give it the room. */
  | { readonly kind: 'free'; readonly botId: string }
  /** Take it off a room that is empty and not 24/7. */
  | { readonly kind: 'reclaim'; readonly botId: string; readonly from: string }
  /** Every bot here is busy, but the server has not invited them all. */
  | { readonly kind: 'invite' }
  /** Every bot the server has is busy, and there are no more to invite. */
  | { readonly kind: 'full' };

export interface AllocationInput {
  readonly voiceChannelId: string;
  /** In a stable order — allocation is deterministic, which makes it testable. */
  readonly fleet: readonly FleetMember[];
  readonly now: number;
  /** How long a room must have been empty before it can be taken. */
  readonly reclaimGraceMs: number;
  /** Whether any player bot exists that this server has not invited yet. */
  readonly hasUninvitedPlayers: boolean;
}

export function allocateBot(input: AllocationInput): Allocation {
  const here = input.fleet.filter((member) => member.inGuild);

  // 1. Already serving this room, or already promised it.
  for (const member of here) {
    if (member.serving?.voiceChannelId === input.voiceChannelId) {
      return { kind: 'existing', botId: member.botId };
    }
    if (member.claimedFor === input.voiceChannelId) {
      return { kind: 'existing', botId: member.botId };
    }
  }

  // 2. Idle and unpromised.
  for (const member of here) {
    if (member.serving === null && member.claimedFor === null) {
      return { kind: 'free', botId: member.botId };
    }
  }

  // 3. Reclaim the room that has been finished with the longest. Preferring
  //    the stalest one means a channel someone just stepped out of is the last
  //    to be taken, not the first.
  let best: { member: FleetMember; emptySince: number } | undefined;
  for (const member of here) {
    const serving = member.serving;
    if (serving === null || member.claimedFor !== null) continue;
    if (serving.stayConnected) continue;
    if (serving.listenersPresent) continue;
    if (serving.emptySince === null) continue;
    if (input.now - serving.emptySince < input.reclaimGraceMs) continue;

    if (best === undefined || serving.emptySince < best.emptySince) {
      best = { member, emptySince: serving.emptySince };
    }
  }
  if (best !== undefined) {
    return {
      kind: 'reclaim',
      botId: best.member.botId,
      // Non-null by construction: only members with a `serving` reach `best`.
      from: best.member.serving?.voiceChannelId ?? '',
    };
  }

  // 4/5. Nothing available. Whether that is fixable by the user is the
  //      difference between a useful message and a dead end.
  return input.hasUninvitedPlayers ? { kind: 'invite' } : { kind: 'full' };
}

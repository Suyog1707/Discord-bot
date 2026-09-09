/**
 * What the fleet looks like from one container.
 *
 * A container knows itself and nothing else. Allocating a room needs the whole
 * picture — which players exist, which this server has invited, and what each
 * one is doing right now — and no single process holds that, so it is assembled
 * from three sources that each own one part of it:
 *
 *   - `player_bots` (Postgres) — every identity this deployment has ever
 *     started, and the application id an invite link needs.
 *   - `guild_bots` (Postgres) — which of them this particular server added.
 *   - the presence entries in Redis — which are running *now*, where to reach
 *     them, and the rooms they are holding.
 *
 * Presence is deliberately the ephemeral half. A container writes its entry on
 * a short interval and the entry expires on its own, so a player that is killed
 * leaves the fleet without anybody's cooperation — which is what a crash
 * actually gives you.
 *
 * The assembly itself is a pure function, so "seven players, three invited, one
 * dead, two idle" is a table in a test rather than a scenario to reproduce.
 */
import type { FleetMember } from './bot-allocation.js';
import type { RoomState } from './room-state.js';

export * from './bot-allocation.js';
export * from './describe-allocation.js';
export * from './room-state.js';

/** One container's own account of itself, as written to Redis. */
export interface BotPresence {
  readonly botId: string;
  /** Discord application id — what an invite URL for this player needs. */
  readonly clientId: string;
  readonly role: 'primary' | 'player';
  /** Every room this container is serving, in every guild. */
  readonly rooms: readonly RoomState[];
  /**
   * Epoch ms this entry was written.
   *
   * The Redis key's own expiry is deliberately generous, so that one slow
   * write or a brief hiccup does not make a healthy player vanish. That
   * generosity is wrong for allocation, which wants a much fresher answer: a
   * bot that stopped answering a minute ago should not be handed a new room and
   * leave somebody looking at a spinner. Reading the age here lets the two use
   * different thresholds without the key needing two lifetimes.
   *
   * Optional because an entry written by a container that predates this field
   * is still a live container — it is treated as fresh rather than dropped, so
   * a rolling deploy does not empty the fleet.
   */
  readonly sentAt?: number;
}

/** One identity as the roster records it, whether or not it is running. */
export interface RosterEntry {
  readonly botId: string;
  readonly clientId: string;
}

export interface FleetView {
  /** What `allocateBot` needs, one entry per identity that could take a room. */
  readonly members: readonly FleetMember[];
  /** Application ids, so an invite can be offered for a player by name. */
  readonly clientIds: ReadonlyMap<string, string>;
  /**
   * Players this guild has not added, in roster order.
   *
   * Computed here because this is the one place that holds both the roster and
   * the guild's invitations. Callers that reconstructed it from `members` and
   * `clientIds` were rebuilding a fact this function already knew, and getting
   * it subtly wrong when a player was in the roster but not running.
   */
  readonly uninvited: readonly RosterEntry[];
  /**
   * The primary, when it is running and in this guild.
   *
   * Which identity is primary is a fact each container states about itself, so
   * it belongs here rather than being guessed from a label.
   */
  readonly primaryBotId: string | undefined;
}

export interface BuildFleetInput {
  /** Every identity in the roster, in the order players should be handed out. */
  readonly roster: readonly RosterEntry[];
  /**
   * Application ids of the players this guild has invited.
   *
   * Application ids rather than labels, because that is what Discord's invite
   * flow and `guild_bots` both speak; a label is this deployment's own name
   * for a bot and means nothing outside it.
   */
  readonly invited: ReadonlySet<string>;
  /** Presence entries, keyed however they arrived; only live players appear. */
  readonly presence: readonly BotPresence[];
  /** Rooms promised but not yet joined, as `botId → voiceChannelId`. */
  readonly claims: ReadonlyMap<string, string>;
  readonly guildId: string;
  /**
   * How old a presence entry may be and still be allocatable, with `now` to
   * measure it against. Omit either to accept every entry the caller found,
   * which is what a reader that only wants the picture — rather than to hand
   * out a room — should do.
   */
  readonly now?: number;
  readonly staleAfterMs?: number;
}

/**
 * Fold the three sources into the one view allocation reads.
 *
 * A player missing from `presence` is left out entirely rather than reported
 * as idle: offering a room to a container that is not running would strand the
 * request, and "every player is busy" is a better answer than silence.
 */
/**
 * Whether a presence entry is too old to be given a room.
 *
 * An entry with no timestamp came from a container that predates the field and
 * is treated as fresh — dropping it would empty the fleet halfway through a
 * rolling deploy, which is a worse failure than the one this guards against.
 */
function isStale(entry: BotPresence, input: BuildFleetInput): boolean {
  const { now, staleAfterMs } = input;
  if (now === undefined || staleAfterMs === undefined) return false;
  if (entry.sentAt === undefined) return false;
  return now - entry.sentAt > staleAfterMs;
}

export function buildFleet(input: BuildFleetInput): FleetView {
  const byId = new Map(input.presence.map((entry) => [entry.botId, entry]));
  const clientIds = new Map<string, string>();
  const members: FleetMember[] = [];
  const uninvited: RosterEntry[] = [];
  let primaryBotId: string | undefined;

  for (const entry of input.roster) {
    clientIds.set(entry.botId, entry.clientId);
    if (!input.invited.has(entry.clientId)) uninvited.push(entry);

    const live = byId.get(entry.botId);
    if (live === undefined) continue;
    if (isStale(live, input)) continue;
    if (live.role === 'primary' && input.invited.has(entry.clientId)) {
      primaryBotId = entry.botId;
    }

    // One token holds one voice connection per server, so a player serves at
    // most one room in this guild — finding a second would mean Discord had
    // changed its mind about that.
    const room = live.rooms.find((candidate) => candidate.guildId === input.guildId);

    members.push({
      botId: entry.botId,
      inGuild: input.invited.has(entry.clientId),
      serving:
        room === undefined
          ? null
          : {
              voiceChannelId: room.voiceChannelId,
              listenersPresent: room.hasListeners,
              stayConnected: room.stayConnected,
              emptySince: room.emptySince,
            },
      claimedFor: input.claims.get(entry.botId) ?? null,
    });
  }

  return { members, clientIds, uninvited, primaryBotId };
}

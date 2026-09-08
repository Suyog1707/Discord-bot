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
import type { RoomState } from './music-manager.js';

/** One container's own account of itself, as written to Redis. */
export interface BotPresence {
  readonly botId: string;
  /** Discord application id — what an invite URL for this player needs. */
  readonly clientId: string;
  readonly role: 'primary' | 'player';
  /** e.g. `http://bot-player-2:8080` — reachable only inside the network. */
  readonly baseUrl: string;
  /** Every room this container is serving, in every guild. */
  readonly rooms: readonly RoomState[];
}

/** One identity as the roster records it, whether or not it is running. */
export interface RosterEntry {
  readonly botId: string;
  readonly clientId: string;
}

export interface FleetView {
  /** What `allocateBot` needs, one entry per identity that could take a room. */
  readonly members: readonly FleetMember[];
  /** Where to reach each live player, by id. */
  readonly addresses: ReadonlyMap<string, string>;
  /** Application ids, so an invite can be offered for a player by name. */
  readonly clientIds: ReadonlyMap<string, string>;
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
}

/**
 * Fold the three sources into the one view allocation reads.
 *
 * A player missing from `presence` is left out entirely rather than reported
 * as idle: offering a room to a container that is not running would strand the
 * request, and "every player is busy" is a better answer than silence.
 */
export function buildFleet(input: BuildFleetInput): FleetView {
  const byId = new Map(input.presence.map((entry) => [entry.botId, entry]));
  const addresses = new Map<string, string>();
  const clientIds = new Map<string, string>();
  const members: FleetMember[] = [];

  for (const entry of input.roster) {
    clientIds.set(entry.botId, entry.clientId);

    const live = byId.get(entry.botId);
    if (live === undefined) continue;
    addresses.set(entry.botId, live.baseUrl);

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

  return { members, addresses, clientIds };
}

/**
 * The next player this guild could add, or undefined when it has them all.
 *
 * Read off the roster rather than off presence: an invite for a player that
 * happens to be restarting is still a valid invite, and the alternative —
 * telling a server it cannot add anything because a container is down — would
 * be wrong for as long as the restart takes.
 */
export function nextUninvited(
  roster: readonly RosterEntry[],
  invited: ReadonlySet<string>,
): RosterEntry | undefined {
  return roster.find((entry) => !invited.has(entry.clientId));
}

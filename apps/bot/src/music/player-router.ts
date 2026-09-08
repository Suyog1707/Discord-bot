/**
 * The fleet, seen as one bot.
 *
 * Every player bot has its own `MusicManager`, and each of those is keyed by
 * guild — correctly, because one token holds one voice connection per server.
 * The extra dimension a server needs to play in several channels at once
 * therefore does not live inside a manager; it lives here, in the choice of
 * *which* manager serves a room.
 *
 * Callers ask for a room and get a player. Which application is actually in
 * the channel is this module's business and nobody else's.
 */
import { botInviteUrl, ValidationError } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';

import { allocateBot, type FleetMember } from './bot-allocation.js';
import type { GuildPlayer } from './guild-player.js';
import type { JoinOptions, MusicManager, RoomState } from './music-manager.js';

const logger = getLogger('player-router');

/**
 * How long a room must have been empty before another channel may take its
 * bot. Long enough to survive a mass move between channels, short enough that
 * a genuinely abandoned room is not held for a noticeable time.
 */
const RECLAIM_GRACE_MS = 60_000;

/** One player bot, as the router sees it. */
export interface RouterBot {
  readonly botId: string;
  /** Discord application id — what an invite URL for this player needs. */
  readonly clientId: string;
  readonly music: MusicManager;
  /** Whether this application is a member of a guild. */
  isInGuild(guildId: string): boolean;
}

/** A room, and the player serving it. */
export interface RoomPlayer {
  readonly botId: string;
  readonly voiceChannelId: string;
  readonly player: GuildPlayer;
  /** The bot's own manager — anything reaching past the player needs it. */
  readonly music: MusicManager;
}

export function roomIdOf(guildId: string, voiceChannelId: string): string {
  return `${guildId}:${voiceChannelId}`;
}

export class PlayerRouter {
  readonly #bots: readonly RouterBot[];
  /**
   * Rooms promised but not yet joined, as `roomId → botId`.
   *
   * Taken *synchronously* before the join begins and released when it finishes
   * or fails. Joining involves a voice handshake and a settle delay, and
   * without this two `/play`s a few milliseconds apart would both see the same
   * bot idle and both take it — the second silently stealing the first's
   * connection.
   */
  readonly #claims = new Map<string, string>();

  /**
   * How many player applications exist in total, invited or not. Lets the
   * "everything is busy" message tell a server it can add another player
   * apart from one that has already added them all.
   */
  readonly #fleetSize: number;

  constructor(bots: readonly RouterBot[]) {
    this.#bots = bots;
    this.#fleetSize = bots.length;
  }

  get size(): number {
    return this.#fleetSize;
  }

  /** Every manager, for wiring that must reach all of them. */
  get managers(): readonly MusicManager[] {
    return this.#bots.map((bot) => bot.music);
  }

  /** The player serving one room, or undefined when nothing is. */
  playerFor(guildId: string, voiceChannelId: string): GuildPlayer | undefined {
    for (const bot of this.#bots) {
      const player = bot.music.getPlayer(guildId);
      if (player?.voiceChannelId === voiceChannelId) return player;
    }
    return undefined;
  }

  /** The manager behind a room — needed wherever a bot's own identity matters. */
  managerFor(guildId: string, voiceChannelId: string): MusicManager | undefined {
    return this.roomFor(guildId, voiceChannelId)?.music;
  }

  /**
   * A room's player together with the manager that owns it.
   *
   * Anything that reaches past the player — tearing the room down, applying a
   * dislike, reading its DJ registry — must go to *that bot's* manager. Asking
   * the primary would silently operate on a different room, or on nothing.
   */
  roomFor(guildId: string, voiceChannelId: string): RoomPlayer | undefined {
    for (const bot of this.#bots) {
      const player = bot.music.getPlayer(guildId);
      if (player?.voiceChannelId === voiceChannelId) {
        return { botId: bot.botId, voiceChannelId, player, music: bot.music };
      }
    }
    return undefined;
  }

  /**
   * Every room this process is serving, across all its bots, as plain data.
   *
   * What a sibling container gets when it asks "what are you doing?" — and the
   * direct answer when the shared room index in Redis is cold.
   */
  ownRooms(): readonly (RoomState & { readonly botId: string })[] {
    return this.#bots.flatMap((bot) =>
      bot.music.rooms.map((room) => ({ ...room, botId: bot.botId })),
    );
  }

  /** Every room currently playing in a guild. */
  roomsIn(guildId: string): readonly RoomPlayer[] {
    const rooms: RoomPlayer[] = [];
    for (const bot of this.#bots) {
      const player = bot.music.getPlayer(guildId);
      if (player !== undefined) {
        rooms.push({
          botId: bot.botId,
          voiceChannelId: player.voiceChannelId,
          player,
          music: bot.music,
        });
      }
    }
    return rooms;
  }

  /**
   * Get the player for a room, joining it with a free bot if none is there.
   *
   * The one place a room is allocated. Everything that wants to start music
   * goes through here so the claim, the reclaim and the "no bots left" message
   * exist in exactly one implementation.
   */
  async joinRoom(options: JoinOptions): Promise<GuildPlayer> {
    const roomId = roomIdOf(options.guildId, options.voiceChannelId);
    const allocation = allocateBot({
      voiceChannelId: options.voiceChannelId,
      fleet: this.#fleetState(options.guildId),
      now: Date.now(),
      reclaimGraceMs: RECLAIM_GRACE_MS,
      hasUninvitedPlayers: this.#hasUninvitedPlayers(options.guildId),
    });

    if (allocation.kind === 'invite') {
      // Name the player and hand over the link. "All busy, sorry" is a dead
      // end; "all busy, here is the one-click fix" is not, and this is the one
      // moment the multi-bot design becomes visible to anybody.
      const next = this.nextUninvited(options.guildId);
      throw new ValidationError(
        next === undefined
          ? 'Every player is busy in another channel right now. Try again shortly.'
          : `Every player is busy in another channel. Add **${next.botId}** to this server and ` +
              `it can play here too:\n${botInviteUrl({
                clientId: next.clientId,
                guildId: options.guildId,
                // A player registers no slash commands.
                withCommands: false,
              })}`,
      );
    }
    if (allocation.kind === 'full') {
      const busy = this.roomsIn(options.guildId)
        .map((room) => `<#${room.voiceChannelId}>`)
        .join(', ');
      throw new ValidationError(
        busy === ''
          ? 'No player is available right now. Try again shortly.'
          : `Every player is already busy — currently in ${busy}. Wait for one to finish, ` +
              'or join one of those channels.',
      );
    }

    const bot = this.#bots.find((candidate) => candidate.botId === allocation.botId);
    if (bot === undefined) {
      throw new ValidationError('No player is available right now. Try again shortly.');
    }

    // Claim before the first await, or a second request racing this one would
    // see the same bot idle and take it too.
    this.#claims.set(roomId, bot.botId);
    try {
      if (allocation.kind === 'reclaim') {
        logger.info(
          {
            guildId: options.guildId,
            botId: bot.botId,
            from: allocation.from,
            to: options.voiceChannelId,
          },
          'Reclaiming a player from an empty channel',
        );
      }
      return await bot.music.getOrCreatePlayer(options);
    } finally {
      this.#claims.delete(roomId);
    }
  }

  /** Tear down one room, leaving every other room in the guild untouched. */
  async leaveRoom(guildId: string, voiceChannelId: string): Promise<void> {
    for (const bot of this.#bots) {
      const player = bot.music.getPlayer(guildId);
      if (player?.voiceChannelId === voiceChannelId) {
        await bot.music.destroyPlayer(guildId);
        return;
      }
    }
  }

  /** What each bot is doing in this guild, in fleet order. */
  #fleetState(guildId: string): readonly FleetMember[] {
    return this.#bots.map((bot) => {
      const player = bot.music.getPlayer(guildId);
      const claimedRoom = [...this.#claims.entries()].find(([, botId]) => botId === bot.botId)?.[0];

      return {
        botId: bot.botId,
        inGuild: bot.isInGuild(guildId),
        serving:
          player === undefined
            ? null
            : {
                voiceChannelId: player.voiceChannelId,
                listenersPresent: player.hasListeners,
                stayConnected: player.stayConnected,
                emptySince: player.emptySince,
              },
        claimedFor: claimedRoom === undefined ? null : (claimedRoom.split(':')[1] ?? null),
      };
    });
  }

  /** Whether the guild could add a player it has not invited yet. */
  #hasUninvitedPlayers(guildId: string): boolean {
    return this.nextUninvited(guildId) !== undefined;
  }

  /** The next player this guild has not added, in fleet order. */
  nextUninvited(guildId: string): RouterBot | undefined {
    return this.#bots.find((bot) => !bot.isInGuild(guildId));
  }
}

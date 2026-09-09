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
import {
  allocateBot,
  describeAllocation,
  PLAYER_BOT_STALE_MS,
  buildFleet,
  ValidationError,
  type BotAllocation,
  type BotPresence,
  type FleetView,
  type RosterEntry,
} from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';

import { applyIntent } from './apply-intent.js';
import type { GuildPlayer } from './guild-player.js';
import type { IntentResult, RoomIntent } from './intent.js';
import type { JoinOptions, MusicManager, RoomState } from './music-manager.js';
import type { PeerDirectory } from './peers.js';

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

/**
 * A room and the container holding it.
 *
 * `local` is present only when that container is this one. Everything else a
 * caller wants to do with the room travels as an intent, which runs where the
 * queue is — so the same call site serves both cases without knowing which it
 * got.
 */
export interface RoomHandle {
  readonly botId: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly local: RoomPlayer | undefined;
}

/** Where the roster and a guild's invitations come from. */
export interface FleetSource {
  /** Every identity this deployment has started, in the order to hand out. */
  listBots(): Promise<readonly RosterEntry[]>;
  /** Application ids of the players one guild has added. */
  botsInGuild(guildId: string): Promise<ReadonlySet<string>>;
}

export interface PlayerRouterOptions {
  readonly peers?: PeerDirectory;
  readonly fleet?: FleetSource;
  /**
   * How long a room must have been empty before another channel may take its
   * bot. From env, so it can be tuned without a rebuild.
   */
  readonly reclaimGraceMs?: number;
}

export class PlayerRouter {
  readonly #bots: readonly RouterBot[];
  /**
   * Rooms promised but not yet joined, as `botId → voiceChannelId`.
   *
   * Taken *synchronously* before the join begins and released when it finishes
   * or fails. Joining involves a voice handshake and a settle delay, and
   * without this two `/play`s a few milliseconds apart would both see the same
   * bot idle and both take it — the second silently stealing the first's
   * connection.
   *
   * Local to this process, which is enough because the primary is the only
   * container that allocates. A distributed lock would buy nothing and cost a
   * round trip on the path of every `/play`.
   */
  readonly #claims = new Map<string, string>();

  /**
   * In-flight allocations, one promise per guild.
   *
   * The queue that makes the claim above meaningful now that deciding involves
   * reads — see {@link PlayerRouter.claimBot}.
   */
  readonly #allocating = new Map<string, Promise<void>>();

  /**
   * How to reach the containers this process is not. Absent in development,
   * where one process is the whole deployment and every room is local by
   * definition.
   */
  readonly #peers: PeerDirectory | undefined;

  /** Who else exists, and which of them this server has. */
  readonly #fleet: FleetSource | undefined;

  readonly #reclaimGraceMs: number;

  constructor(bots: readonly RouterBot[], options: PlayerRouterOptions = {}) {
    this.#bots = bots;
    this.#peers = options.peers;
    this.#fleet = options.fleet;
    this.#reclaimGraceMs = options.reclaimGraceMs ?? RECLAIM_GRACE_MS;
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
   * Run an intent against a room, wherever it lives.
   *
   * The only thing a caller needs to know is the room. Whether that means a
   * method call on a player in this process or an HTTP request to a sibling is
   * this method's business — and the local path is the same code the sibling
   * would run, so there is one implementation, not two.
   */
  async runIntent(intent: RoomIntent): Promise<IntentResult> {
    const local = this.roomFor(intent.guildId, intent.voiceChannelId);
    if (local !== undefined) return applyIntent(local, intent);

    const owner = await this.#peers?.ownerOf(intent.guildId, intent.voiceChannelId);
    if (owner === undefined || owner.botId === this.#peers?.selfBotId) {
      // Nobody owns it, or the only claim is a stale one of our own — either
      // way there is no player here to act on.
      return { kind: 'error', message: 'Nothing is playing in that channel.' };
    }
    return this.#peers?.sendIntent(owner, intent) ?? { kind: 'error', message: 'No player.' };
  }

  /**
   * The room's DJ state, for the command guard.
   *
   * Three scalars, and `decideDjAuthority` is already pure — so this is the
   * whole of what the guard needs from a room another container owns.
   */
  async authorityFor(
    guildId: string,
    voiceChannelId: string,
    issuedBy: string,
  ): Promise<
    | {
        readonly botVoiceChannelId: string;
        readonly hostId: string | null;
        readonly sessionDjIds: readonly string[];
      }
    | undefined
  > {
    const result = await this.runIntent({
      action: 'authority',
      guildId,
      voiceChannelId,
      issuedBy,
    });
    return result.kind === 'authority' ? result : undefined;
  }

  /**
   * Get the player for a room, joining it with a free bot if none is there.
   *
   * The one place a room is allocated. Everything that wants to start music
   * goes through here so the claim, the reclaim and the "no bots left" message
   * exist in exactly one implementation.
   *
   * Returns a player only when the room turns out to be local. Callers that
   * can cope with a room somewhere else should use {@link openRoom} and send
   * the rest of what they wanted to do as an intent.
   */
  async joinRoom(options: JoinOptions): Promise<GuildPlayer> {
    const handle = await this.openRoom(options);
    if (handle.local === undefined) {
      // Reached only by a caller that has not been taught the remote path.
      // Better a clear refusal than a player object that is quietly the wrong
      // bot's.
      throw new ValidationError(
        `That channel is being served by **${handle.botId}**, which this bot cannot reach.`,
      );
    }
    return handle.local.player;
  }

  /**
   * Put a bot in a room and say where it ended up.
   *
   * The result is deliberately not a player: the room may be held by another
   * container, and the honest answer there is an address, not an object. What
   * the caller wanted to do next travels as an intent instead — one round
   * trip, run where the queue actually lives.
   */
  async openRoom(options: JoinOptions): Promise<RoomHandle> {
    const existing = this.roomFor(options.guildId, options.voiceChannelId);
    if (existing !== undefined) {
      // Already ours. `getOrCreatePlayer` is still called so a join that only
      // updates the text channel or the listener behaves as it always has.
      return {
        botId: existing.botId,
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        local: { ...existing, player: await existing.music.getOrCreatePlayer(options) },
      };
    }

    const owner = await this.#peers?.ownerOf(options.guildId, options.voiceChannelId);
    if (owner !== undefined && owner.botId !== this.#peers?.selfBotId) {
      // Somebody else is already in that channel; joining is a no-op and the
      // caller's real work is an intent for them.
      return {
        botId: owner.botId,
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        local: undefined,
      };
    }

    return this.#allocateRoom(options);
  }

  /**
   * Take a room with this container's own bot, allocation already decided.
   *
   * What `POST /join` calls. The primary has picked this player, so there is
   * nothing left to choose — but the refusal below still matters: one token
   * holds one voice connection per server, so a player already in another
   * channel of this guild must say so rather than abandon that channel.
   */
  async joinLocal(
    options: JoinOptions,
  ): Promise<
    { readonly kind: 'joined' } | { readonly kind: 'busy'; readonly voiceChannelId: string }
  > {
    const [bot] = this.#bots;
    if (bot === undefined) throw new ValidationError('This player has no audio server.');

    const player = bot.music.getPlayer(options.guildId);
    if (player !== undefined && player.voiceChannelId !== options.voiceChannelId) {
      return { kind: 'busy', voiceChannelId: player.voiceChannelId };
    }

    await bot.music.getOrCreatePlayer(options);
    return { kind: 'joined' };
  }

  /**
   * Pick a bot for a room and reserve it, one guild at a time.
   *
   * Deciding now needs three reads — the roster, the guild's invitations and
   * the presence entries — so it can no longer happen between two synchronous
   * statements. Two `/play`s a few milliseconds apart would otherwise both see
   * the same player idle and both take it, the second silently stealing the
   * first's connection.
   *
   * So allocations for one guild are made in turn: each waits for the previous
   * to finish reserving before it starts reading. The reservation is what the
   * next one sees, and it is released as soon as the join finishes — the join
   * itself, which is a voice handshake and a settle delay, happens outside the
   * queue and does not hold anybody up.
   *
   * Per guild, not global: two servers starting music at the same moment are
   * not competing for anything, and making them wait for each other would be a
   * cost with nothing bought.
   */
  async #claimBot(
    options: JoinOptions,
  ): Promise<{ readonly allocation: BotAllocation; readonly view: FleetView }> {
    const previous = this.#allocating.get(options.guildId);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#allocating.set(options.guildId, mine);

    try {
      await previous;
    } catch {
      // A failed allocation is the caller's problem, not the next one's.
    }

    try {
      const view = await this.#fleetView(options.guildId);
      const allocation = allocateBot({
        voiceChannelId: options.voiceChannelId,
        fleet: view.members,
        now: Date.now(),
        reclaimGraceMs: this.#reclaimGraceMs,
        hasUninvitedPlayers: view.uninvited.length > 0,
      });

      // Nothing available. Whether that is fixable by the user — "add another
      // bot, here is the link" — is the difference between a useful message and
      // a dead end, and the wording lives beside the decision so it cannot be
      // lost when the router starts making that decision instead.
      if (allocation.kind === 'invite' || allocation.kind === 'full') {
        throw new ValidationError(describeAllocation(allocation, view, options.guildId));
      }

      this.#claims.set(allocation.botId, options.voiceChannelId);
      return { allocation, view };
    } finally {
      release();
      // Only if nobody has queued behind this one; otherwise theirs is current.
      if (this.#allocating.get(options.guildId) === mine) {
        this.#allocating.delete(options.guildId);
      }
    }
  }

  /** Choose a bot for a room nobody is serving, and put it there. */
  async #allocateRoom(options: JoinOptions): Promise<RoomHandle> {
    const { allocation, view } = await this.#claimBot(options);

    try {
      if (allocation.kind === 'reclaim') {
        logger.info(
          {
            guildId: options.guildId,
            botId: allocation.botId,
            from: allocation.from,
            to: options.voiceChannelId,
          },
          'Reclaiming a player from an empty channel',
        );
      }

      const local = this.#bots.find((candidate) => candidate.botId === allocation.botId);
      if (local !== undefined) {
        const player = await local.music.getOrCreatePlayer(options);
        return {
          botId: local.botId,
          guildId: options.guildId,
          voiceChannelId: options.voiceChannelId,
          local: {
            botId: local.botId,
            voiceChannelId: options.voiceChannelId,
            player,
            music: local.music,
          },
        };
      }

      const baseUrl = view.addresses.get(allocation.botId);
      const peers = this.#peers;
      if (baseUrl === undefined || peers === undefined) {
        throw new ValidationError('No player is available right now. Try again shortly.');
      }

      const outcome = await peers.sendJoin(baseUrl, options);
      if (outcome.kind === 'error') throw new ValidationError(outcome.message);
      if (outcome.kind === 'busy') {
        // The picture was a moment out of date. Say so plainly rather than
        // retrying into the same race.
        throw new ValidationError(
          `**${allocation.botId}** has just been taken for <#${outcome.voiceChannelId}>. ` +
            'Try again in a moment.',
        );
      }

      logger.info(
        {
          guildId: options.guildId,
          voiceChannelId: options.voiceChannelId,
          botId: allocation.botId,
        },
        'Room handed to another container',
      );
      return {
        botId: allocation.botId,
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        local: undefined,
      };
    } finally {
      this.#claims.delete(allocation.botId);
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

  /**
   * The fleet as it stands, for this guild.
   *
   * Assembled from the roster, the guild's invitations and the presence
   * entries in Redis — see `fleet.ts` for why each part comes from where it
   * does. With no fleet source (development, one process) this container is
   * the whole fleet, which is the shape it has always had.
   */
  async #fleetView(guildId: string): Promise<FleetView> {
    const fleet = this.#fleet;
    const peers = this.#peers;
    if (fleet === undefined || peers === undefined) return this.#localFleetView(guildId);

    const [roster, invited, presence, routed] = await Promise.all([
      fleet.listBots(),
      fleet.botsInGuild(guildId),
      peers.liveBots(),
      peers.claimedRooms(),
    ]);
    // A roster that has not caught up with this container yet would leave it
    // out of its own allocation, so it stands in for itself.
    if (roster.length === 0) return this.#localFleetView(guildId);

    return buildFleet({
      roster,
      invited,
      presence: this.#withOwnRooms(presence),
      /**
       * This process's own reservations, plus any the command router made.
       *
       * The router picks a bot before the command reaches it, and its choice
       * arrives here as a claim on that bot — so `allocateBot` answers
       * `existing` and this container agrees with the decision instead of
       * making a second one. No separate "you were chosen" protocol.
       */
      claims: new Map([...routed, ...this.#claims]),
      guildId,
      now: Date.now(),
      staleAfterMs: PLAYER_BOT_STALE_MS,
    });
  }

  /**
   * Replace this container's own presence entry with what it actually holds.
   *
   * Its copy in Redis is a snapshot from the last heartbeat or room change and
   * can be a moment out of date — which is fine for a sibling reading it, and
   * not fine here: a container that has just taken a room would otherwise offer
   * itself that room again. Nobody knows this container's state better than it
   * does, so for itself the live answer wins.
   */
  #withOwnRooms(presence: readonly BotPresence[]): readonly BotPresence[] {
    const own = new Set(this.#bots.map((bot) => bot.botId));
    return [
      ...presence.filter((entry) => !own.has(entry.botId)),
      ...this.#bots.map((bot) => ({
        botId: bot.botId,
        clientId: bot.clientId,
        role: presence.find((entry) => entry.botId === bot.botId)?.role ?? 'primary',
        baseUrl: presence.find((entry) => entry.botId === bot.botId)?.baseUrl ?? '',
        rooms: bot.music.rooms,
      })),
    ];
  }

  /** This container, seen as the whole fleet. */
  #localFleetView(guildId: string): FleetView {
    const members = this.#bots.map((bot) => {
      const player = bot.music.getPlayer(guildId);
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
        claimedFor: this.#claims.get(bot.botId) ?? null,
      };
    });

    return {
      members,
      addresses: new Map(),
      clientIds: new Map(this.#bots.map((bot) => [bot.botId, bot.clientId])),
      // This container is the whole fleet, so "not invited" means one of its
      // own bots is not in this guild.
      uninvited: this.#bots
        .filter((bot) => !bot.isInGuild(guildId))
        .map((bot) => ({ botId: bot.botId, clientId: bot.clientId })),
      primaryBotId: this.#bots.find((bot) => bot.isInGuild(guildId))?.botId,
    };
  }
}

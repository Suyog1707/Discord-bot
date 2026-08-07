/**
 * Music engine entry point: one Shoukaku instance, one `GuildPlayer` per
 * active guild, and track resolution against Lavalink.
 *
 * Constructed only when Lavalink is configured (`getLavalinkNode()`), so the
 * rest of the bot treats `client.music` as `MusicManager | undefined` and
 * degrades cleanly when the audio server is absent in development.
 */
import {
  encodePlayerEvent,
  isUnreachableError,
  NotFoundError,
  summarizeSocketError,
  UpstreamError,
  ValidationError,
  type PlayerEventType,
  type PlayerSnapshot,
} from '@discord-music/shared';
import type { Client } from 'discord.js';
import {
  Connectors,
  Constants,
  LoadType,
  Shoukaku,
  type LavalinkResponse,
  type Node,
} from 'shoukaku';

import type { LavalinkNode } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { GuildService } from '../services/guild-service.js';
import { ControllerMessage } from './controller.js';
import { GuildPlayer } from './guild-player.js';
import type { QueueStore } from './queue-store.js';
import { buildSearchQuery, fromLavalinkTrack, type QueuedTrack } from './track.js';

const logger = getLogger('music');

/** How often to re-probe an audio server that Shoukaku gave up on. */
const RECONNECT_PROBE_INTERVAL_MS = 30_000;
/** A reachability probe should answer immediately or not at all. */
const PROBE_TIMEOUT_MS = 2_000;

export interface ResolveResult {
  readonly tracks: readonly QueuedTrack[];
  /** Set when the identifier resolved to a whole playlist. */
  readonly playlistName: string | null;
}

export interface JoinOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly shardId: number;
}

export class MusicManager {
  readonly shoukaku: Shoukaku;
  readonly #players = new Map<string, GuildPlayer>();
  readonly #client: Client;
  readonly #store: QueueStore;
  readonly #guilds: GuildService;
  readonly #node: LavalinkNode;
  /** Nodes already carrying a give-up listener, so retries never double-log. */
  readonly #watchedNodes = new WeakSet<Node>();
  #reconnectTimer: NodeJS.Timeout | undefined;

  readonly #publishEvent: ((payload: string) => void) | undefined;
  readonly #controllers = new Map<string, ControllerMessage>();

  constructor(options: {
    readonly client: Client;
    readonly node: LavalinkNode;
    readonly store: QueueStore;
    readonly guilds: GuildService;
    /** Serialised event sink; absent when Redis is not configured. */
    readonly publishEvent?: (payload: string) => void;
  }) {
    this.#client = options.client;
    this.#store = options.store;
    this.#guilds = options.guilds;
    this.#node = options.node;
    this.#publishEvent = options.publishEvent;

    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(options.client),
      [
        {
          name: options.node.name,
          url: options.node.url,
          auth: options.node.auth,
          secure: options.node.secure,
        },
      ],
      {
        resume: true,
        resumeTimeout: 30,
        reconnectTries: 5,
        reconnectInterval: 5,
        // Player state moves elsewhere if a node dies (single node today, but
        // correct once more are added).
        moveOnDisconnect: true,
        userAgent: 'discord-music-platform/0.1.0',
      },
    );

    this.shoukaku.on('ready', (name, lavalinkResume) => {
      this.#ensureGiveUpWatched();
      logger.info({ node: name, resumed: lavalinkResume }, 'Lavalink node ready');
    });
    this.shoukaku.on('error', (name, error) => {
      this.#ensureGiveUpWatched();
      // An absent audio server is an operator problem, not a fault: Node reports
      // it as an AggregateError whose stack is a wall of duplicated frames
      // saying nothing the address does not. Log the address and move on — the
      // give-up handler explains what to do about it.
      if (isUnreachableError(error)) {
        logger.warn({ node: name, ...summarizeSocketError(error) }, 'Lavalink node unreachable');
        return;
      }
      logger.error({ err: error, node: name }, 'Lavalink node error');
    });
    this.shoukaku.on('close', (name, code, reason) => {
      logger.warn(
        { node: name, code, reason: reason === '' ? undefined : reason },
        'Lavalink node closed',
      );
    });
    this.shoukaku.on('reconnecting', (name, triesLeft) => {
      this.#ensureGiveUpWatched();
      logger.warn({ node: name, triesLeft }, 'Lavalink node reconnecting');
    });

    this.#startNodeSupervisor();
  }

  /**
   * Announce the moment Shoukaku stops retrying.
   *
   * The manager never re-emits `disconnect` despite declaring it — `addNode`
   * subscribes to the node's own event only to drop it from the pool — so this
   * listens to the node directly. Without it the bot simply falls silent after
   * the last retry, which is exactly when an operator needs to be told why
   * music stopped working.
   *
   * Attached on demand rather than in the constructor: the discord.js connector
   * does not register the node until the gateway client is ready, so there is
   * nothing to subscribe to until the first node event arrives.
   */
  #ensureGiveUpWatched(): void {
    const node = this.shoukaku.nodes.get(this.#node.name);
    if (node === undefined || this.#watchedNodes.has(node)) return;
    this.#watchedNodes.add(node);

    node.once('disconnect', (movedPlayers) => {
      logger.warn(
        { node: this.#node.name, address: this.#node.url, movedPlayers },
        'Lavalink gave up reconnecting — music commands are unavailable until it returns. ' +
          'Start it with `pnpm run docker:up`; the bot re-checks every 30s.',
      );
    });
  }

  /**
   * Restore an audio server that Shoukaku has abandoned.
   *
   * Once `reconnectTries` is exhausted the node is deleted from the pool and
   * never retried, so a Lavalink that comes up late — the normal case when the
   * bot starts before the audio container has finished booting — stays dead
   * until the process restarts. Re-adding it is only safe once the server is
   * actually answering: Shoukaku 4.3.0 also discards a retry that *succeeds*
   * after an earlier failure (`connectError` is never cleared on the success
   * path), so the probe guarantees the first attempt is the one that lands.
   */
  #startNodeSupervisor(): void {
    if (this.#reconnectTimer !== undefined) return;

    const timer = setInterval(() => {
      void this.#superviseNode();
    }, RECONNECT_PROBE_INTERVAL_MS);
    // Never hold the process open purely to retry an optional dependency.
    timer.unref();
    this.#reconnectTimer = timer;
  }

  #stopNodeSupervisor(): void {
    if (this.#reconnectTimer === undefined) return;
    clearInterval(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  async #superviseNode(): Promise<void> {
    const node = this.shoukaku.nodes.get(this.#node.name);
    // Present means connected, still retrying, or closing — Shoukaku owns all
    // three, and stepping in would open a second socket.
    if (node !== undefined && node.state !== Constants.State.DISCONNECTED) return;

    if (!(await this.#isNodeReachable())) return;

    logger.info({ node: this.#node.name }, 'Lavalink reachable again — rejoining the node pool');
    if (node !== undefined) this.shoukaku.removeNode(this.#node.name, 'Replaced by supervisor');
    this.shoukaku.addNode({
      name: this.#node.name,
      url: this.#node.url,
      auth: this.#node.auth,
      secure: this.#node.secure,
    });
    this.#ensureGiveUpWatched();
  }

  /** Cheap liveness check against the Lavalink REST API. */
  async #isNodeReachable(): Promise<boolean> {
    const scheme = this.#node.secure ? 'https' : 'http';
    try {
      const response = await fetch(`${scheme}://${this.#node.url}/version`, {
        headers: { Authorization: this.#node.auth },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Whether at least one Lavalink node is connected and usable. */
  get isAvailable(): boolean {
    return this.shoukaku.getIdealNode() !== undefined;
  }

  get activePlayerCount(): number {
    return this.#players.size;
  }

  getPlayer(guildId: string): GuildPlayer | undefined {
    return this.#players.get(guildId);
  }

  /** Get the existing player or join the voice channel and create one. */
  async getOrCreatePlayer(options: JoinOptions): Promise<GuildPlayer> {
    const existing = this.#players.get(options.guildId);
    if (existing !== undefined) return existing;

    if (!this.isAvailable) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    const settings = await this.#guilds.getSettings(options.guildId);

    // Persistent controller lives in the configured music channel; when set it
    // replaces per-track announcements (one continuously edited message, never
    // a new message per song).
    if (settings.musicChannelId !== null && !this.#controllers.has(options.guildId)) {
      this.#controllers.set(
        options.guildId,
        new ControllerMessage(this.#client, options.guildId, settings.musicChannelId),
      );
    }
    const controllerActive = this.#controllers.has(options.guildId);

    const player = await this.shoukaku.joinVoiceChannel({
      guildId: options.guildId,
      channelId: options.voiceChannelId,
      shardId: options.shardId,
      deaf: true,
    });

    const guildPlayer = new GuildPlayer({
      guildId: options.guildId,
      voiceChannelId: options.voiceChannelId,
      textChannelId: options.textChannelId,
      player,
      client: this.#client,
      store: this.#store,
      announce: settings.announceNowPlaying && !controllerActive,
      initialVolume: settings.defaultVolume,
      idleTimeoutSeconds: settings.leaveOnEmptyAfter,
      stayConnected: settings.stayConnected,
      autoplayEnabled: settings.autoplayEnabled,
      onSelfDestruct: async (guildId, reason) => {
        logger.info({ guildId, reason }, 'Player self-destructing');
        await this.destroyPlayer(guildId);
      },
      onAutoplayRequest: (guildId) => this.pickAutoplayTracks(guildId),
      onEvent: (type, state) => {
        this.#emitEvent(options.guildId, type, state);
      },
    });

    this.#emitEvent(options.guildId, 'PLAYER_CONNECT', guildPlayer.snapshot());

    this.#players.set(options.guildId, guildPlayer);
    logger.info({ guildId: options.guildId, channelId: options.voiceChannelId }, 'Player created');
    return guildPlayer;
  }

  /**
   * Smart autoplay: pick tracks that continue the guild's listening session.
   *
   * Seeds Lavalink searches with the artists heard most recently, then
   * filters the results for freshness — nothing already in the recent
   * history, no live streams, sane durations, and at most two picks per
   * artist so the radio does not collapse into one act's discography.
   */
  async pickAutoplayTracks(guildId: string): Promise<readonly QueuedTrack[]> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return [];

    const history = await this.#store.recentHistory(guildId, 40);
    if (history.length === 0) return [];

    const playedIdentifiers = new Set(history.map((entry) => entry.identifier));
    // "Artist - Topic" / "ArtistVEVO" are YouTube channel artifacts, not names.
    const cleanAuthor = (author: string): string =>
      author.replace(/\s*-\s*Topic$/iu, '').replace(/VEVO$/iu, '');

    const seedAuthors = [...new Set(history.slice(0, 8).map((entry) => cleanAuthor(entry.author)))]
      .filter((author) => author.length > 0)
      .slice(0, 3);

    const picks: QueuedTrack[] = [];
    const perAuthorCount = new Map<string, number>();
    const requester = { id: this.#client.user?.id ?? '0', name: 'Autoplay' };

    for (const seed of seedAuthors) {
      if (picks.length >= 5) break;

      let response: LavalinkResponse | undefined;
      try {
        response = await node.rest.resolve(`ytsearch:${seed}`);
      } catch (error) {
        logger.debug({ err: error, seed }, 'Autoplay seed search failed');
        continue;
      }
      if (response?.loadType !== LoadType.SEARCH) continue;

      for (const raw of response.data) {
        if (picks.length >= 5) break;
        const track = fromLavalinkTrack(raw, requester);

        if (playedIdentifiers.has(track.identifier)) continue;
        if (picks.some((pick) => pick.identifier === track.identifier)) continue;
        if (track.isStream) continue;
        if (track.durationMs < 60_000 || track.durationMs > 600_000) continue;
        const author = cleanAuthor(track.author);
        if ((perAuthorCount.get(author) ?? 0) >= 2) continue;

        perAuthorCount.set(author, (perAuthorCount.get(author) ?? 0) + 1);
        picks.push(track);
      }
    }

    logger.info({ guildId, seeds: seedAuthors, picked: picks.length }, 'Autoplay selection');
    return picks;
  }

  /**
   * Rejoin voice and restore queues for guilds configured for 24/7 mode.
   * Called once after the gateway is ready; every failure is per-guild and
   * non-fatal — a missing channel simply skips that guild.
   */
  async restoreStayConnectedPlayers(): Promise<void> {
    let guildIds: readonly string[];
    try {
      guildIds = await this.#store.stayConnectedGuildIds();
    } catch (error) {
      logger.warn({ err: error }, '24/7 restore query failed');
      return;
    }

    for (const guildId of guildIds) {
      try {
        const persisted = await this.#store.loadPersisted(guildId);
        if (persisted === null) continue;

        const guild = this.#client.guilds.cache.get(guildId);
        if (guild === undefined) continue;
        const channel = guild.channels.cache.get(persisted.voiceChannelId);
        if (channel?.isVoiceBased() !== true) continue;

        const player = await this.getOrCreatePlayer({
          guildId,
          voiceChannelId: persisted.voiceChannelId,
          textChannelId: persisted.textChannelId,
          shardId: guild.shardId,
        });
        player.queue.restore(persisted.tracks, persisted.currentIndex, persisted.loopMode);
        await player.setVolume(persisted.volume);

        // Resume from the track after the last known one — the position within
        // the old track is stale by now, and skipping forward beats replaying.
        const next = player.queue.skip();
        if (next !== null) await player.jumpTo(player.queue.currentIndex);

        logger.info(
          { guildId, tracks: persisted.tracks.length },
          '24/7: rejoined voice and restored the queue',
        );
      } catch (error) {
        logger.warn({ err: error, guildId }, '24/7 restore failed for this guild');
      }
    }
  }

  #emitEvent(guildId: string, type: PlayerEventType, state: PlayerSnapshot | null): void {
    this.#publishEvent?.(encodePlayerEvent({ type, guildId, sentAt: Date.now(), state }));
    this.#controllers.get(guildId)?.onEvent(type, state);
  }

  /** Tear down a guild's player and leave its voice channel. */
  async destroyPlayer(guildId: string): Promise<void> {
    const player = this.#players.get(guildId);
    if (player === undefined) return;

    this.#players.delete(guildId);
    const controller = this.#controllers.get(guildId);
    this.#controllers.delete(guildId);
    if (controller !== undefined) await controller.destroy();
    await player.destroy();
    try {
      await this.shoukaku.leaveVoiceChannel(guildId);
    } catch (error) {
      logger.debug({ err: error, guildId }, 'leaveVoiceChannel failed (already gone?)');
    }
    logger.info({ guildId }, 'Player destroyed');
  }

  /** Tear down everything — shutdown path. */
  async destroyAll(): Promise<void> {
    this.#stopNodeSupervisor();
    await Promise.allSettled([...this.#players.keys()].map((id) => this.destroyPlayer(id)));
  }

  /**
   * Resolve user input (URL or free text) into playable tracks.
   *
   * @throws {NotFoundError} Nothing matched.
   * @throws {ValidationError} Lavalink rejected the input.
   * @throws {UpstreamError} No node available or the node errored.
   */
  async resolve(
    input: string,
    requestedBy: { readonly id: string; readonly name: string },
    source: 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<ResolveResult> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    let response: LavalinkResponse | undefined;
    try {
      response = await node.rest.resolve(buildSearchQuery(input, source));
    } catch (error) {
      throw new UpstreamError('Track lookup failed. Try again shortly.', { cause: error });
    }

    if (response === undefined) {
      throw new NotFoundError('No results for that query.');
    }

    switch (response.loadType) {
      case LoadType.TRACK:
        return { tracks: [fromLavalinkTrack(response.data, requestedBy)], playlistName: null };

      case LoadType.SEARCH: {
        const [first] = response.data;
        if (first === undefined) throw new NotFoundError('No results for that query.');
        return { tracks: [fromLavalinkTrack(first, requestedBy)], playlistName: null };
      }

      case LoadType.PLAYLIST:
        return {
          tracks: response.data.tracks.map((track) => fromLavalinkTrack(track, requestedBy)),
          playlistName: response.data.info.name,
        };

      case LoadType.EMPTY:
        throw new NotFoundError('No results for that query.');

      case LoadType.ERROR:
        throw new ValidationError(
          `That could not be loaded: ${response.data.message || 'unknown error'}.`,
        );
    }
  }
}

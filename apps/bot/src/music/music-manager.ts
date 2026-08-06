/**
 * Music engine entry point: one Shoukaku instance, one `GuildPlayer` per
 * active guild, and track resolution against Lavalink.
 *
 * Constructed only when Lavalink is configured (`getLavalinkNode()`), so the
 * rest of the bot treats `client.music` as `MusicManager | undefined` and
 * degrades cleanly when the audio server is absent in development.
 */
import { NotFoundError, UpstreamError, ValidationError } from '@discord-music/shared';
import type { Client } from 'discord.js';
import { Connectors, LoadType, Shoukaku, type LavalinkResponse } from 'shoukaku';

import type { LavalinkNode } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { GuildService } from '../services/guild-service.js';
import { GuildPlayer } from './guild-player.js';
import type { QueueStore } from './queue-store.js';
import { buildSearchQuery, fromLavalinkTrack, type QueuedTrack } from './track.js';

const logger = getLogger('music');

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

  constructor(options: {
    readonly client: Client;
    readonly node: LavalinkNode;
    readonly store: QueueStore;
    readonly guilds: GuildService;
  }) {
    this.#client = options.client;
    this.#store = options.store;
    this.#guilds = options.guilds;

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
      logger.info({ node: name, resumed: lavalinkResume }, 'Lavalink node ready');
    });
    this.shoukaku.on('error', (name, error) => {
      logger.error({ err: error, node: name }, 'Lavalink node error');
    });
    this.shoukaku.on('close', (name, code) => {
      logger.warn({ node: name, code }, 'Lavalink node closed');
    });
    this.shoukaku.on('reconnecting', (name, triesLeft) => {
      logger.warn({ node: name, triesLeft }, 'Lavalink node reconnecting');
    });
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
      announce: settings.announceNowPlaying,
      initialVolume: settings.defaultVolume,
      idleTimeoutSeconds: settings.leaveOnEmptyAfter,
      onSelfDestruct: async (guildId, reason) => {
        logger.info({ guildId, reason }, 'Player self-destructing');
        await this.destroyPlayer(guildId);
      },
    });

    this.#players.set(options.guildId, guildPlayer);
    logger.info({ guildId: options.guildId, channelId: options.voiceChannelId }, 'Player created');
    return guildPlayer;
  }

  /** Tear down a guild's player and leave its voice channel. */
  async destroyPlayer(guildId: string): Promise<void> {
    const player = this.#players.get(guildId);
    if (player === undefined) return;

    this.#players.delete(guildId);
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

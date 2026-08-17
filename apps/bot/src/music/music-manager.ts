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
  type MusicSource,
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
  type Track as LavalinkTrack,
} from 'shoukaku';

import type { AutoplayEngine } from '../ai/autoplay.js';
import { identityOf } from '../ai/identity.js';
import type { MusicOrchestrator } from '../ai/orchestrator.js';
import type { AutoplaySessionStore, SessionEntry } from '../ai/session.js';
import type { LavalinkNode } from '../config/env.js';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { GuildService } from '../services/guild-service.js';
import type { SpotifyService } from '../services/spotify-service.js';
import { ControllerMessage } from './controller.js';
import { GuildPlayer } from './guild-player.js';
import {
  isSpotifyUrl,
  isSpotifyWebUrl,
  resolveSpotifyUrl,
  searchQueryFor,
  searchSpotifyBest,
} from './spotify-resolver.js';
import type { SpotifyTrackMeta } from './spotify-resolver.js';
import type { QueueStore } from './queue-store.js';
import { resolvePlatformLinks, type PlatformLinks } from './platform-links.js';
import {
  buildSearchQuery,
  fromLavalinkTrack,
  isPlausibleAlternative,
  type QueuedTrack,
} from './track.js';

const logger = getLogger('music');

/** How often to re-probe an audio server that Shoukaku gave up on. */
const RECONNECT_PROBE_INTERVAL_MS = 30_000;
/** A reachability probe should answer immediately or not at all. */
const PROBE_TIMEOUT_MS = 2_000;
/** How many tracks one autoplay top-up adds. */
const AUTOPLAY_PICK_TARGET = 5;

export interface ResolveResult {
  readonly tracks: readonly QueuedTrack[];
  /** Set when the identifier resolved to a whole playlist. */
  readonly playlistName: string | null;
  /** Present when the collection has more tracks than were returned above. */
  readonly background?: SpotifyExpansion;
  /**
   * The source withheld part of the collection and no amount of paging will
   * retrieve it — currently only Spotify's public embed, which caps at 100.
   */
  readonly truncated?: boolean;
}

export interface SpotifyBackgroundResolution {
  readonly sourceTrackCount: number;
  readonly resolvedTrackCount: number;
  readonly failedTrackCount: number;
}

export interface SpotifyExpansion {
  /**
   * Resolve the rest of the collection, handing each finished batch to
   * `onTracks` in queue order. Batches are emitted as they complete so the
   * queue keeps filling while the first tracks are already playing.
   */
  readonly run: (
    onTracks: (tracks: readonly QueuedTrack[]) => Promise<void>,
  ) => Promise<SpotifyBackgroundResolution>;
}

/**
 * How long a Lavalink search result is reused for the same query.
 *
 * Spotify playback is one search per track, so replaying a playlist otherwise
 * repeats hundreds of identical searches. Encoded tracks stay playable well
 * beyond this window — Lavalink re-resolves the stream when it plays them.
 */
const SEARCH_CACHE_TTL_MS = 30 * 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 2_000;

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
  readonly #spotify: SpotifyService;
  readonly #node: LavalinkNode;
  /** Nodes already carrying a give-up listener, so retries never double-log. */
  readonly #watchedNodes = new WeakSet<Node>();
  #reconnectTimer: NodeJS.Timeout | undefined;

  /**
   * The recommendation-backed autoplay engine, when the AI stack is configured.
   * Undefined leaves autoplay on its original YouTube-mix behaviour.
   */
  #autoplay: AutoplayEngine | undefined;
  /** The engine's session store — played/queued/reserved state per guild. */
  #autoplaySession: AutoplaySessionStore | undefined;

  readonly #publishEvent: ((payload: string) => void) | undefined;
  readonly #controllers = new Map<string, ControllerMessage>();
  /** Insertion-ordered so the oldest entry is the one evicted at capacity. */
  readonly #searchCache = new Map<string, { track: LavalinkTrack; expiresAt: number }>();

  constructor(options: {
    readonly client: Client;
    readonly node: LavalinkNode;
    readonly store: QueueStore;
    readonly guilds: GuildService;
    readonly spotify: SpotifyService;
    /** Serialised event sink; absent when Redis is not configured. */
    readonly publishEvent?: (payload: string) => void;
  }) {
    this.#client = options.client;
    this.#store = options.store;
    this.#guilds = options.guilds;
    this.#spotify = options.spotify;
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

    // Persistent controller: the voice channel's own text chat when Discord
    // exposes it to the bot, otherwise the configured music channel. When one
    // exists it replaces per-track announcements (one continuously edited
    // message, never a new message per song).
    if (!this.#controllers.has(options.guildId)) {
      const voiceChat = this.#client.channels.cache.get(options.voiceChannelId);
      const botUserId = this.#client.user?.id;
      const canUseVoiceChat =
        voiceChat?.isVoiceBased() === true &&
        voiceChat.isSendable() &&
        botUserId !== undefined &&
        (voiceChat.permissionsFor(botUserId)?.has(['ViewChannel', 'SendMessages']) ?? false);
      const controllerChannelId = canUseVoiceChat
        ? options.voiceChannelId
        : settings.musicChannelId;
      if (controllerChannelId !== null) {
        this.#controllers.set(
          options.guildId,
          new ControllerMessage(this.#client, options.guildId, controllerChannelId),
        );
      }
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
      // A track actually started: this is the moment it becomes "recently
      // played" in the session ledger (recommended ≠ played — only real
      // playback events move this state), and the moment to warm the buffer
      // so the next top-up is a map lookup rather than a generation pass.
      onTrackStarted: (guildId, track) => {
        const session = this.#autoplaySession;
        if (session !== undefined) {
          void session.recordPlayed(guildId, this.#sessionEntryOf(track)).catch(() => undefined);
          if (track.requestedByName === 'Autoplay') {
            void session.recordOutcome(guildId, 'played').catch(() => undefined);
            logger.debug(
              { event: 'RECOMMENDATION_PLAYED', guildId, track: track.title },
              'Autoplay pick started',
            );
          }
        }
        // Seed window: the track that just started plus the last few played,
        // straight from the in-memory queue. A window (rather than one seed)
        // is what lets the engine recognise an existing buffer as "still
        // following this session" instead of regenerating on every track.
        const player = this.#players.get(guildId);
        const played =
          player === undefined
            ? []
            : player.queue.tracks.slice(0, Math.max(0, player.queue.currentIndex)).slice(-3);
        this.#autoplay?.prefetch(guildId, [
          { title: track.title, artist: track.author, identifier: track.identifier },
          ...played.reverse().map((entry) => ({
            title: entry.title,
            artist: entry.author,
            identifier: entry.identifier,
          })),
        ]);
      },
      // Learning: completions and early skips of autoplay picks are the
      // recommendation outcomes future scoring feeds on.
      onTrackFinished: (guildId, track, outcome) => {
        const session = this.#autoplaySession;
        if (session === undefined || track.requestedByName !== 'Autoplay') return;
        const completed =
          !outcome.skipped && track.durationMs > 0 && outcome.playedMs / track.durationMs >= 0.8;
        const kind = outcome.skipped ? 'skipped' : completed ? 'completed' : null;
        if (kind !== null) {
          void session.recordOutcome(guildId, kind).catch(() => undefined);
          logger.debug(
            {
              event: kind === 'skipped' ? 'RECOMMENDATION_SKIPPED' : 'RECOMMENDATION_COMPLETED',
              guildId,
              track: track.title,
            },
            'Autoplay pick finished',
          );
        }
      },
      onFindAlternative: (track, failedSource) => this.findAlternativeSource(track, failedSource),
      onResolveLinks: (track) => this.platformLinksFor(track),
      onEvent: (type, state) => {
        // Keep the session's queued-set mirrored on every queue mutation.
        if (type === 'QUEUE_UPDATE' || type === 'QUEUE_CLEAR' || type === 'TRACK_START') {
          this.#syncSessionQueue(options.guildId);
        }
        // A stop empties the queue; picks buffered for the old session would
        // be the wrong music for whatever comes next, and their reservations
        // must be released so the songs are not penalised unheard.
        if (type === 'QUEUE_CLEAR') {
          this.#autoplay?.clear(options.guildId);
        }
        this.#emitEvent(options.guildId, type, state);
      },
    });

    this.#emitEvent(options.guildId, 'PLAYER_CONNECT', guildPlayer.snapshot());

    this.#players.set(options.guildId, guildPlayer);
    logger.info({ guildId: options.guildId, channelId: options.voiceChannelId }, 'Player created');
    return guildPlayer;
  }

  /**
   * The same recording from a source other than the one that just failed.
   *
   * YouTube refuses to stream some videos to anonymous clients — label-owned
   * music especially — and until now that turned into "skipping" even when the
   * song was sitting on SoundCloud. Metadata sources (Spotify, Apple Music)
   * cannot supply audio, so they are never a target: for those the *display*
   * source stays put and only the underlying stream is swapped.
   */
  async findAlternativeSource(
    track: QueuedTrack,
    failedSource: MusicSource,
  ): Promise<QueuedTrack | null> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return null;

    // Whatever just failed, try the other streaming source. A Spotify-sourced
    // track failed on YouTube (that is where its audio came from), so it too
    // falls through to SoundCloud.
    const alternative: 'youtube' | 'soundcloud' =
      failedSource === 'soundcloud' ? 'youtube' : 'soundcloud';

    const query = `${track.title} ${track.author}`.trim();
    const match = await this.#searchOne(node, query, alternative).catch(() => null);
    if (match === null) return null;

    const replacement = fromLavalinkTrack(match, {
      id: track.requestedById,
      name: track.requestedByName,
    });

    // Search on the fallback source returns *something* for any query — often a
    // remix, or a different song by the same artist. Playing the wrong track is
    // worse than admitting we could not play this one.
    if (!isPlausibleAlternative(track, replacement)) {
      logger.debug(
        { wanted: track.title, got: replacement.title, source: alternative },
        'Rejected implausible alternative',
      );
      return null;
    }
    return {
      ...replacement,
      // Keep the listener-facing identity of the track they queued; only the
      // stream behind it changed.
      title: track.title,
      author: track.author,
      artworkUrl: track.artworkUrl ?? replacement.artworkUrl,
    };
  }

  /** Cross-platform "listen on" links for a track. */
  async platformLinksFor(track: QueuedTrack): Promise<PlatformLinks> {
    const node = this.shoukaku.getIdealNode();
    return resolvePlatformLinks(track, async (prefixed) => {
      if (node === undefined) return null;
      const response = await node.rest.resolve(prefixed);
      if (response?.loadType !== LoadType.SEARCH) return null;
      return response.data[0]?.info.uri ?? null;
    });
  }

  /**
   * Attach the recommendation-backed autoplay engine.
   *
   * Called once at boot when the AI stack is configured. Also hands the
   * orchestrator the resolver it needs, which is the only direction the
   * dependency runs in — the AI layer never imports the player.
   */
  attachAutoplay(engine: AutoplayEngine, orchestrator: MusicOrchestrator): void {
    this.#autoplay = engine;
    this.#autoplaySession = engine.session;
    orchestrator.setResolver(async (candidate) => this.resolveCandidate(candidate));
  }

  /** A queue/history track as the session store sees it. */
  #sessionEntryOf(track: {
    readonly title: string;
    readonly author: string;
    readonly identifier: string;
    readonly sourceKey?: string;
  }): SessionEntry {
    const identity = identityOf(track.author, track.title);
    return {
      key: identity.key,
      identifier: track.identifier,
      artistKey: identity.artistKey,
      // A recommended track is known under two spellings: the YouTube upload
      // (computed above) and the Last.fm candidate it was picked as. Session
      // state carries both so the exclusion layer matches either vocabulary.
      ...(track.sourceKey === undefined || track.sourceKey === identity.key
        ? {}
        : { altKey: track.sourceKey }),
    };
  }

  /**
   * Mirror a guild's live queue (current track included) into the session
   * store. Called on every queue mutation, so the recommendation pipeline's
   * "already queued" exclusion can never drift from the real queue.
   */
  #syncSessionQueue(guildId: string): void {
    const session = this.#autoplaySession;
    if (session === undefined) return;
    const player = this.#players.get(guildId);
    const entries =
      player === undefined
        ? []
        : [
            ...(player.queue.current === null ? [] : [player.queue.current]),
            ...player.queue.upcoming,
          ].map((track) => this.#sessionEntryOf(track));
    void session.syncQueue(guildId, entries).catch(() => undefined);
  }

  /**
   * Turn a recommended `artist — title` into something Lavalink can play.
   *
   * The plausibility guard matters more here than anywhere else: a search for a
   * track YouTube does not have returns *something* regardless, and without the
   * check autoplay would confidently queue a lyric video, a cover, or an
   * unrelated song that merely shares a word with the request.
   */
  async resolveCandidate(candidate: {
    readonly title: string;
    readonly artist: string;
  }): Promise<QueuedTrack | null> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return null;

    const raw = await this.#searchOne(node, `${candidate.artist} ${candidate.title}`);
    if (raw === null) return null;

    const track = fromLavalinkTrack(raw, {
      id: this.#client.user?.id ?? '0',
      name: 'Autoplay',
    });

    // Live streams and radio rips are not songs; long uploads are usually full
    // albums or hour-long mixes that would swallow the queue.
    if (track.isStream) return null;
    if (track.durationMs < 60_000 || track.durationMs > 900_000) return null;

    // Duration 0 deliberately: a recommendation carries a title and an artist
    // but no running time, and `isPlausibleAlternative` treats a non-positive
    // duration as "nothing to compare" — so the word-overlap and variant checks
    // still apply while the duration comparison is skipped rather than faked.
    const wanted = { title: candidate.title, author: candidate.artist, durationMs: 0 };
    if (!isPlausibleAlternative(wanted, track)) {
      logger.debug(
        {
          wanted: `${candidate.artist} — ${candidate.title}`,
          got: `${track.author} — ${track.title}`,
        },
        'Rejected an implausible recommendation match',
      );
      return null;
    }

    return track;
  }

  /** Drop a guild's prefetched autoplay buffer — on stop or disconnect. */
  clearAutoplayBuffer(guildId: string): void {
    this.#autoplay?.clear(guildId);
  }

  /** One Lavalink search, served from the short-lived result cache when possible. */
  async #searchOne(
    node: Node,
    query: string,
    source: 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<LavalinkTrack | null> {
    // The prefix is part of the key: the same title on SoundCloud and YouTube
    // are different recordings, and a shared key would serve one for the other.
    const prefixed = buildSearchQuery(query, source);
    const cached = this.#searchCache.get(prefixed);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return cached.track;
      this.#searchCache.delete(prefixed);
    }

    const response = await node.rest.resolve(prefixed);
    if (response?.loadType !== LoadType.SEARCH) return null;
    const [best] = response.data;
    if (best === undefined) return null;

    if (this.#searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.#searchCache.keys().next();
      if (!(oldest.done ?? false)) this.#searchCache.delete(oldest.value);
    }
    this.#searchCache.set(prefixed, { track: best, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    return best;
  }

  /**
   * Map Spotify tracks to playable matches via Lavalink search.
   *
   * Work is done in batches of `SPOTIFY_RESOLVE_CONCURRENCY`: parallel within a
   * batch for throughput, batch-by-batch so `onBatch` receives tracks in queue
   * order and the queue grows while the earlier tracks are already playing.
   */
  async #matchSpotifyTracks(
    metadata: readonly SpotifyTrackMeta[],
    requestedBy: { readonly id: string; readonly name: string },
    onBatch?: (tracks: readonly QueuedTrack[]) => Promise<void>,
    source: 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<SpotifyBackgroundResolution> {
    if (metadata.length === 0) {
      return { sourceTrackCount: 0, resolvedTrackCount: 0, failedTrackCount: 0 };
    }

    const node = this.shoukaku.getIdealNode();
    if (node === undefined) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    const startedAt = Date.now();
    const batchSize = Math.max(1, getEnv().SPOTIFY_RESOLVE_CONCURRENCY);
    let resolvedCount = 0;

    for (let offset = 0; offset < metadata.length; offset += batchSize) {
      const batch = metadata.slice(offset, offset + batchSize);
      const matched = await Promise.all(
        batch.map(async (meta): Promise<QueuedTrack | null> => {
          try {
            const best = await this.#searchOne(node, searchQueryFor(meta), source);
            if (best === null) return null;
            const track = fromLavalinkTrack(best, requestedBy);
            // Spotify is metadata-only: its identity is what the listener sees
            // (title, artist, artwork and — crucially — the URL), while the
            // Lavalink match supplies only the audio. The playback provider's
            // page must never become the public URL of a Spotify track.
            return {
              ...track,
              title: meta.title,
              author: meta.artist,
              artworkUrl: meta.artworkUrl ?? track.artworkUrl,
              uri: meta.spotifyUrl ?? track.uri,
              source: 'spotify',
            };
          } catch (error) {
            logger.debug({ err: error, title: meta.title }, 'Spotify track match failed');
            return null;
          }
        }),
      );

      const tracks = matched.flatMap((track) => (track === null ? [] : [track]));
      resolvedCount += tracks.length;
      if (tracks.length > 0 && onBatch !== undefined) await onBatch(tracks);
    }

    logger.info(
      {
        sourceTracks: metadata.length,
        resolved: resolvedCount,
        failed: metadata.length - resolvedCount,
        durationMs: Date.now() - startedAt,
        batchSize,
      },
      'Spotify Lavalink resolution complete',
    );
    return {
      sourceTrackCount: metadata.length,
      resolvedTrackCount: resolvedCount,
      failedTrackCount: metadata.length - resolvedCount,
    };
  }

  /**
   * Resolve a Spotify URL into something playable *now*, plus a continuation.
   *
   * Only the smallest prefix that yields a playable track is awaited here — a
   * large collection would otherwise put its entire metadata paging and one
   * search per track in front of the first note. Everything else is handed
   * back as {@link SpotifyExpansion} for the caller to drain after replying.
   */
  async #resolveSpotify(
    url: string,
    requestedBy: { readonly id: string; readonly name: string },
    source: 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<ResolveResult> {
    if (this.shoukaku.getIdealNode() === undefined) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    const metadataStartedAt = Date.now();
    const resolution = await resolveSpotifyUrl(url, requestedBy.id, this.#spotify);
    logger.info(
      {
        firstPageTracks: resolution.tracks.length,
        paged: resolution.more !== undefined,
        durationMs: Date.now() - metadataStartedAt,
      },
      'Spotify metadata fetch complete',
    );
    const firstPage = resolution.tracks;
    if (firstPage.length === 0 && resolution.more === undefined) {
      throw new NotFoundError('That Spotify link contains no playable tracks.');
    }

    const batchSize = Math.max(1, getEnv().SPOTIFY_RESOLVE_CONCURRENCY);
    // A collection that continues beyond this page starts on its first track;
    // one that fits in a single batch resolves fully for the same wall clock.
    const hasMore = resolution.more !== undefined || firstPage.length > batchSize;
    const headTracks: QueuedTrack[] = [];
    const collect = (tracks: readonly QueuedTrack[]): Promise<void> => {
      headTracks.push(...tracks);
      return Promise.resolve();
    };

    let consumed = hasMore ? Math.min(1, firstPage.length) : firstPage.length;
    await this.#matchSpotifyTracks(firstPage.slice(0, consumed), requestedBy, collect, source);
    // The very first track can be unmatchable; widen until something plays.
    while (headTracks.length === 0 && consumed < firstPage.length) {
      const batch = firstPage.slice(consumed, consumed + batchSize);
      await this.#matchSpotifyTracks(batch, requestedBy, collect, source);
      consumed += batch.length;
    }

    const pending = firstPage.slice(consumed);
    const expansion: SpotifyExpansion = {
      run: async (onTracks) => {
        // Start the remaining metadata pages before matching what we already
        // have, so paging overlaps with searching instead of following it.
        const morePages = resolution.more?.();
        // Awaited below; this only keeps a paging failure from surfacing as an
        // unhandled rejection if the matching ahead of it throws first.
        morePages?.catch(() => undefined);

        const fromFirstPage = await this.#matchSpotifyTracks(
          pending,
          requestedBy,
          onTracks,
          source,
        );
        if (morePages === undefined) return fromFirstPage;

        const rest = await morePages;
        const fromRest = await this.#matchSpotifyTracks(rest, requestedBy, onTracks, source);
        return {
          sourceTrackCount: fromFirstPage.sourceTrackCount + fromRest.sourceTrackCount,
          resolvedTrackCount: fromFirstPage.resolvedTrackCount + fromRest.resolvedTrackCount,
          failedTrackCount: fromFirstPage.failedTrackCount + fromRest.failedTrackCount,
        };
      },
    };
    const background =
      pending.length === 0 && resolution.more === undefined ? undefined : expansion;

    if (headTracks.length === 0) {
      // Nothing on the first page matched. Drain the continuation inline rather
      // than reporting a failure the caller could have played through.
      if (background !== undefined) {
        const drained: QueuedTrack[] = [];
        await background.run((tracks) => {
          drained.push(...tracks);
          return Promise.resolve();
        });
        if (drained.length > 0) {
          return { tracks: drained, playlistName: resolution.collectionName };
        }
      }
      throw new NotFoundError('No playable matches found for that Spotify link.');
    }

    const truncated = resolution.truncated ?? false;
    return background === undefined
      ? { tracks: headTracks, playlistName: resolution.collectionName, truncated }
      : { tracks: headTracks, playlistName: resolution.collectionName, background, truncated };
  }

  /**
   * Resolve known Spotify track metadata into playable tracks, batch by batch.
   *
   * The public face of `#matchSpotifyTracks`, for callers that already hold
   * Spotify metadata (the `/spotify` playlist browser): each track keeps its
   * Spotify identity — title, artist, artwork and URL — while the audio is
   * matched separately, exactly like a pasted Spotify link.
   */
  async resolveSpotifyMetadata(
    metadata: readonly SpotifyTrackMeta[],
    requestedBy: { readonly id: string; readonly name: string },
    onBatch: (tracks: readonly QueuedTrack[]) => Promise<void>,
  ): Promise<SpotifyBackgroundResolution> {
    return this.#matchSpotifyTracks(metadata, requestedBy, onBatch);
  }

  /**
   * Queue a mixed list of ready tracks and unresolved queries, in order.
   *
   * Stored playlists and Spotify mirrors hold one search per unresolved track,
   * which run `SPOTIFY_RESOLVE_CONCURRENCY` at a time here instead of strictly
   * one after another. Each finished batch goes to `onBatch` in list order, so
   * playback starts on the first batch while the rest is still being looked up.
   *
   * @returns How many tracks were handed to `onBatch`.
   */
  async resolveEach(
    items: readonly (string | QueuedTrack)[],
    requestedBy: { readonly id: string; readonly name: string },
    onBatch: (tracks: readonly QueuedTrack[]) => Promise<void>,
  ): Promise<number> {
    const batchSize = Math.max(1, getEnv().SPOTIFY_RESOLVE_CONCURRENCY);
    let queued = 0;

    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);
      const results = await Promise.all(
        batch.map(async (item): Promise<QueuedTrack | null> => {
          if (typeof item !== 'string') return item;
          try {
            const [track] = (await this.resolve(item, requestedBy)).tracks;
            return track ?? null;
          } catch (error) {
            // One dead link must not sink the batch.
            logger.debug({ err: error, query: item }, 'Batch resolve failed for one entry');
            return null;
          }
        }),
      );

      const tracks = results.flatMap((track) => (track === null ? [] : [track]));
      if (tracks.length === 0) continue;
      queued += tracks.length;
      await onBatch(tracks);
    }
    return queued;
  }

  /**
   * Smart autoplay: pick tracks that continue the guild's listening session.
   *
   * Seeded from YouTube's own mix for the track just played, because that is
   * the only source here that understands taste. Searching an artist's name —
   * what this used to do — returns whatever YouTube ranks globally for that
   * string, so a Hindi set could wander into unrelated English pop by the
   * second or third pick. A mix for a Hindi track stays Hindi.
   *
   * Falls back to the artist search when no mix is available, then filters both
   * for freshness — nothing already in the recent history, no live streams,
   * sane durations, and at most two picks per artist so the radio does not
   * collapse into one act's discography.
   */
  async pickAutoplayTracks(guildId: string): Promise<readonly QueuedTrack[]> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return [];

    const history = await this.#store.recentHistory(guildId, 40);
    if (history.length === 0) return [];

    // The recommendation engine goes first when it is configured: it knows the
    // guild's taste, its recent skips and the language it listens in, none of
    // which a mix URL does. It returns nothing when Last.fm is unavailable or
    // the pool came back thin, and the YouTube-mix path below then runs exactly
    // as it did before any of this existed.
    const engine = this.#autoplay;
    if (engine !== undefined) {
      // The session's queued-set must be current BEFORE generation reads it:
      // this is the hard "already in the queue" exclusion.
      this.#syncSessionQueue(guildId);
      const seeds = history.slice(0, 4).map((entry) => ({
        title: entry.title,
        artist: entry.author,
        identifier: entry.identifier,
      }));

      const recommended = await engine.take(guildId, AUTOPLAY_PICK_TARGET, seeds);
      if (recommended.length > 0) {
        logger.info(
          {
            event: 'RECOMMENDATION_QUEUED',
            guildId,
            strategy: 'recommender',
            picked: recommended.length,
          },
          'Autoplay selection',
        );
        return recommended;
      }
      logger.debug({ guildId }, 'Recommender returned nothing; falling back to mixes');
    }

    // The mix fallback shares the recommender's exclusion state where it can:
    // history identifiers always, plus the session's queued/recent sets when
    // the AI stack is wired.
    const sessionSnapshot = await this.#autoplaySession?.snapshot(guildId).catch(() => undefined);
    const playedIdentifiers = new Set([
      ...history.map((entry) => entry.identifier),
      ...(sessionSnapshot?.recentIdentifiers ?? []),
      ...(sessionSnapshot?.queuedIdentifiers ?? []),
    ]);
    const excludedKeys = new Set([
      ...(sessionSnapshot?.recentKeys ?? []),
      ...(sessionSnapshot?.queuedKeys ?? []),
      ...(sessionSnapshot?.reservedKeys ?? []),
    ]);
    // "Artist - Topic" / "ArtistVEVO" are YouTube channel artifacts, not names.
    const cleanAuthor = (author: string): string =>
      author.replace(/\s*-\s*Topic$/iu, '').replace(/VEVO$/iu, '');

    const seedAuthors = [...new Set(history.slice(0, 8).map((entry) => cleanAuthor(entry.author)))]
      .filter((author) => author.length > 0)
      .slice(0, 3);

    const picks: QueuedTrack[] = [];
    const perAuthorCount = new Map<string, number>();
    const requester = { id: this.#client.user?.id ?? '0', name: 'Autoplay' };

    /** Keep a candidate only if it is fresh, playable and not over-represented. */
    const consider = (raw: LavalinkTrack): void => {
      if (picks.length >= AUTOPLAY_PICK_TARGET) return;
      const track = fromLavalinkTrack(raw, requester);

      const trackKey = identityOf(track.author, track.title).key;
      if (playedIdentifiers.has(track.identifier)) return;
      if (excludedKeys.has(trackKey)) return;
      // Within this batch, dedupe by canonical key as well as identifier —
      // two different uploads of one song are still one song.
      if (
        picks.some(
          (pick) =>
            pick.identifier === track.identifier ||
            identityOf(pick.author, pick.title).key === trackKey,
        )
      ) {
        return;
      }
      if (track.isStream) return;
      if (track.durationMs < 60_000 || track.durationMs > 600_000) return;
      const author = cleanAuthor(track.author);
      if ((perAuthorCount.get(author) ?? 0) >= 2) return;

      perAuthorCount.set(author, (perAuthorCount.get(author) ?? 0) + 1);
      picks.push(track);
    };

    // YouTube mixes are keyed by video id, so only sources whose identifier is
    // one can seed them. Spotify qualifies: its queue entries carry the id of
    // the YouTube match that actually played.
    const mixSeeds = history
      .filter((entry) => entry.source === 'youtube' || entry.source === 'spotify')
      .slice(0, 2);

    for (const seed of mixSeeds) {
      if (picks.length >= AUTOPLAY_PICK_TARGET) break;
      try {
        const mix = await node.rest.resolve(
          `https://www.youtube.com/watch?v=${seed.identifier}&list=RD${seed.identifier}`,
        );
        if (mix?.loadType !== LoadType.PLAYLIST) continue;
        // The mix opens with the seed itself; it is already in the history.
        for (const raw of mix.data.tracks) consider(raw);
      } catch (error) {
        logger.debug({ err: error, seed: seed.identifier }, 'Autoplay mix lookup failed');
      }
    }

    if (picks.length > 0) {
      logger.info(
        {
          guildId,
          strategy: 'mix',
          seeds: mixSeeds.map((s) => s.identifier),
          picked: picks.length,
        },
        'Autoplay selection',
      );
      return picks;
    }

    for (const seed of seedAuthors) {
      if (picks.length >= AUTOPLAY_PICK_TARGET) break;

      let response: LavalinkResponse | undefined;
      try {
        response = await node.rest.resolve(`ytsearch:${seed}`);
      } catch (error) {
        logger.debug({ err: error, seed }, 'Autoplay seed search failed');
        continue;
      }
      if (response?.loadType !== LoadType.SEARCH) continue;

      for (const raw of response.data) consider(raw);
    }

    logger.info(
      { guildId, strategy: 'artist-search', seeds: seedAuthors, picked: picks.length },
      'Autoplay selection',
    );
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
    // Free the prefetch buffer with the player; a guild that left should not
    // keep tracks parked in memory waiting for a queue that will never drain.
    this.#autoplay?.clear(guildId);
    const player = this.#players.get(guildId);
    if (player === undefined) return;

    this.#players.delete(guildId);
    // The queue is gone with the player; the session's queued-mirror must not
    // keep excluding tracks from a queue that no longer exists. Recent-play
    // history intentionally survives: reconnecting must not reset anti-repeat.
    this.#syncSessionQueue(guildId);
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
   * `source: 'auto'` (what `/play` sends when the user picked nothing) makes
   * Spotify the canonical catalogue for free text: the query is ranked against
   * Spotify's tracks, albums, artists and playlists, and a credible match is
   * resolved through the Spotify pipeline so its metadata — including the
   * user-facing URL — stays Spotify's. Lavalink search remains the fallback
   * when Spotify is unconfigured, unreachable, has no credible match, or the
   * matched item yields nothing playable.
   *
   * @throws {NotFoundError} Nothing matched.
   * @throws {ValidationError} Lavalink rejected the input.
   * @throws {UpstreamError} No node available or the node errored.
   */
  async resolve(
    input: string,
    requestedBy: { readonly id: string; readonly name: string },
    source: 'auto' | 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<ResolveResult> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    // An explicitly chosen source narrows the search; 'auto' searches Spotify
    // first and falls back to YouTube below.
    const searchSource: 'youtube' | 'soundcloud' =
      source === 'soundcloud' ? 'soundcloud' : 'youtube';

    // Spotify links: metadata from the Web API, audio via search on the
    // playback sources — Spotify audio itself is never streamed.
    if (isSpotifyUrl(input)) {
      return this.#resolveSpotify(input, requestedBy, searchSource);
    }
    if (isSpotifyWebUrl(input)) {
      throw new ValidationError('Unsupported or invalid Spotify link.');
    }

    if (source === 'auto' && !/^https?:\/\//iu.test(input.trim())) {
      const hit = await searchSpotifyBest(input);
      if (hit !== null) {
        try {
          return await this.#resolveSpotify(hit.url, requestedBy, searchSource);
        } catch (error) {
          // The catalogue had a match but nothing playable came of it — the
          // plain provider search below still gets its chance.
          logger.debug(
            { err: error, query: input, kind: hit.kind, name: hit.name },
            'Spotify-first resolution fell through to provider search',
          );
        }
      }
    }

    let response: LavalinkResponse | undefined;
    try {
      response = await node.rest.resolve(buildSearchQuery(input, searchSource));
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

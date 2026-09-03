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

import { selectAutoplaySeeds, type AnchorHistoryEntry } from '../ai/anchors.js';
import type { AutoplayPlanner } from '../ai/autoplay-planner.js';
import type { AutoplayEngine } from '../ai/autoplay.js';
import type { FamiliarCandidate } from '../ai/familiar-scoring.js';
import { identityOf } from '../ai/identity.js';
import type { MusicOrchestrator } from '../ai/orchestrator.js';
import type { TrackSeed } from '../ai/recommender.js';
import type { AutoplaySessionStore, SessionEntry } from '../ai/session.js';
import type { LavalinkNode } from '../config/env.js';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { GuildService } from '../services/guild-service.js';
import type { SpotifyService } from '../services/spotify-service.js';
import { decideHandover } from './channel-handover.js';
import { ControllerMessage } from './controller.js';
import { GuildPlayer } from './guild-player.js';
import {
  isSpotifyUrl,
  isSpotifyWebUrl,
  resolveSpotifyUrl,
  searchSpotifyBest,
} from './spotify-resolver.js';
import {
  canonicalTrack,
  describeCanonical,
  joinedArtists,
  type CanonicalTrack,
} from './canonical-track.js';
import {
  requestedVariantsOf,
  type MatchCandidate,
  type PlaybackProvider,
} from './candidate-matcher.js';
import { AUTOPLAY_WEIGHTS } from './match-config.js';
import { identifyCanonicalTrack } from './metadata-providers.js';
import { resolvePlayback, ResolutionCache, type ResolvedPlayback } from './playback-resolver.js';
import { getResolutionSettings } from './resolution-settings.js';
import type { SpotifyTrackMeta } from './spotify-resolver.js';
import type { PersistedQueue, QueueStore, StayConnectedSession } from './queue-store.js';
import { resolvePlatformLinks, type PlatformLinks } from './platform-links.js';
import {
  buildSearchQuery,
  fromLavalinkTrack,
  playbackSourceOf,
  trackOrigin,
  type QueuedTrack,
} from './track.js';

const logger = getLogger('music');

/** How often to re-probe an audio server that Shoukaku gave up on. */
const RECONNECT_PROBE_INTERVAL_MS = 30_000;
/** A reachability probe should answer immediately or not at all. */
const PROBE_TIMEOUT_MS = 2_000;
/**
 * How many tracks one autoplay top-up adds. Deliberately tiny — Smart-Shuffle
 * style just-in-time batches: each pair is generated fresh from the taste
 * anchors plus the feedback on the pair before it, so a mediocre pick costs
 * two songs, not a queue. Large batches also drift structurally: fifteen picks
 * from one generation wholesale replace the "recent listening" context the
 * next generation reads.
 */
const AUTOPLAY_PICK_TARGET = 2;
/** Ceiling on one refill request, whatever the caller asks for. */
const AUTOPLAY_MAX_PICKS = 10;

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
/** Results kept per search for ranking. Beyond this the tail is never the release. */
const SEARCH_CANDIDATE_LIMIT = 10;

/**
 * How stale a channel's saved queue may be and still come back when the bot
 * returns to it.
 *
 * The point of per-channel queues is that stepping away and coming back
 * resumes the room, not that a list from last week ambushes whoever plays
 * next. Twelve hours comfortably covers "we moved rooms" and "the bot idled
 * out an hour ago"; beyond that the channel starts clean.
 */
const QUEUE_RESUME_WINDOW_MS = 12 * 60 * 60_000;

/**
 * Accept threshold when no catalogue could identify the query.
 *
 * Three of the strongest signals — a canonical runtime, a known artist and an
 * ISRC — are simply absent on this path, so scores land far lower than they do
 * for an identified track and the full threshold would reject everything. The
 * vetoes, the ranking and the version rules are unchanged: this lowers the bar
 * for evidence, not the standard for what counts as a song.
 */
const UNIDENTIFIED_ACCEPT_SCORE = 28;

/**
 * Where a caller wants the audio to come from.
 *
 * `auto` is the architecture's default and means "ask the metadata layer what
 * this song is, then try the playback providers in priority order". The two
 * explicit values pin resolution to one provider, which is what `/play
 * source:` has always done and what the alternative-source recovery needs.
 */
export type PlaybackPreference = 'auto' | PlaybackProvider;

/**
 * A Lavalink result wearing the matcher's interface.
 *
 * The scorer works on plain fields; the Lavalink object rides along so the
 * winner can be handed back as the thing the player actually needs.
 */
interface LavalinkCandidate extends MatchCandidate {
  readonly track: LavalinkTrack;
}

function toCandidate(track: LavalinkTrack): LavalinkCandidate {
  return {
    title: track.info.title,
    author: track.info.author,
    durationMs: track.info.length,
    isStream: track.info.isStream,
    identifier: track.info.identifier,
    // Lavalink v4 surfaces the ISRC when the source manager knows one. It is
    // the strongest signal the matcher has and costs nothing to carry.
    isrc: track.info.isrc ?? null,
    uri: track.info.uri ?? null,
    track,
  };
}

/** Canonical identity for a Spotify recording. */
function canonicalFromSpotify(meta: SpotifyTrackMeta): CanonicalTrack {
  return canonicalTrack({
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    durationMs: meta.durationMs,
    isrc: meta.isrc,
    provider: 'spotify',
    providerId: meta.spotifyId,
    url: meta.spotifyUrl,
    artworkUrl: meta.artworkUrl,
  });
}

export interface JoinOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly shardId: number;
  /** Primary listener to start with — the restore path passes the persisted one. */
  readonly listenerId?: string | null;
  /**
   * Whether entering a channel brings back the queue it was left with.
   * Default true. The 24/7 startup path sets it false because it loads and
   * restores the queue itself, with its own cursor handling.
   */
  readonly resumeSavedQueue?: boolean;
}

/** What a fresh join brought back with it, for the command to mention. */
export interface ResumeNotice {
  readonly voiceChannelId: string;
  readonly trackCount: number;
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
  readonly #retainEvent: ((guildId: string, payload: string | null) => void) | undefined;
  readonly #controllers = new Map<string, ControllerMessage>();
  /** Insertion-ordered so the oldest entry is the one evicted at capacity. */
  /**
   * Whole result lists, not just the winner. Ranking needs the alternatives,
   * and caching only the first result would have meant a second network round
   * trip for the same query the moment anything wanted to compare candidates.
   */
  readonly #searchCache = new Map<
    string,
    { candidates: readonly LavalinkTrack[]; expiresAt: number }
  >();

  /**
   * Accepted resolutions, keyed by canonical identity (ISRC where there is
   * one). Replaying a playlist, or two guilds asking for the same song, skips
   * the whole provider walk. Only confident matches are ever stored — see
   * `ResolutionCache`.
   */
  readonly #resolutionCache = new ResolutionCache<LavalinkCandidate>();

  /**
   * Queues brought back by the most recent join, waiting to be reported.
   * Consumed by whichever command caused the join; dropped if nobody asks.
   */
  readonly #resumeNotices = new Map<string, ResumeNotice>();

  constructor(options: {
    readonly client: Client;
    readonly node: LavalinkNode;
    readonly store: QueueStore;
    readonly guilds: GuildService;
    readonly spotify: SpotifyService;
    /** Serialised event sink; absent when Redis is not configured. */
    readonly publishEvent?: (payload: string) => void;
    /**
     * Sink for the *retained* copy of the same event: the latest snapshot a
     * dashboard connecting later should be handed. `null` means the player is
     * gone and the retained state must be dropped. Absent when Redis is not
     * configured.
     */
    readonly retainEvent?: (guildId: string, payload: string | null) => void;
  }) {
    this.#client = options.client;
    this.#store = options.store;
    this.#guilds = options.guilds;
    this.#spotify = options.spotify;
    this.#node = options.node;
    this.#publishEvent = options.publishEvent;
    this.#retainEvent = options.retainEvent;

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

  /**
   * Get the existing player, or join the voice channel and create one.
   *
   * A request from a DIFFERENT channel than the bot occupies is a handover,
   * not a second connection — Discord allows exactly one voice state per
   * (guild, user). {@link decideHandover} decides whether it is allowed; a
   * room with listeners still in it keeps the bot, and the caller gets a
   * `ValidationError` naming the channel.
   */
  async getOrCreatePlayer(options: JoinOptions): Promise<GuildPlayer> {
    const existing = this.#players.get(options.guildId);
    if (existing !== undefined) {
      const decision = decideHandover({
        currentChannelId: existing.voiceChannelId,
        targetChannelId: options.voiceChannelId,
        listenersInCurrent: this.#listenerCountIn(existing.voiceChannelId),
      });

      if (decision.kind === 'stay') return existing;
      if (decision.kind === 'busy') {
        throw new ValidationError(
          `I'm already playing in <#${existing.voiceChannelId}> for ` +
            `${String(decision.listeners)} listener${decision.listeners === 1 ? '' : 's'}. ` +
            'Join that channel, or wait until it empties out.',
        );
      }

      // The room is empty: park its queue where it can be found again and
      // leave. `destroyPlayer` flushes the queue under the OLD channel's key,
      // which is the whole reason the bot can come back to it later.
      logger.info(
        { guildId: options.guildId, from: existing.voiceChannelId, to: options.voiceChannelId },
        'Handing the bot over to another voice channel',
      );
      await this.destroyPlayer(options.guildId);
      // The session ledger describes a room — what played there, who was
      // listening. None of it applies to the channel being entered.
      await this.#autoplaySession?.clear(options.guildId).catch(() => undefined);
    }

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

    // What this room was left with, if anything. Read before the player is
    // built so the listener it was following is known at construction rather
    // than assigned a beat later.
    const saved =
      options.resumeSavedQueue === false
        ? null
        : await this.#savedQueueFor(options.guildId, options.voiceChannelId);

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
      autoplayLowWaterMark: getEnv().AUTOPLAY_LOW_WATER_MARK,
      listenerId: options.listenerId ?? saved?.listenerId ?? null,
      autoplayTargetQueueSize: getEnv().AUTOPLAY_TARGET_QUEUE_SIZE,
      onSelfDestruct: async (guildId, reason) => {
        logger.info({ guildId, reason }, 'Player self-destructing');
        await this.destroyPlayer(guildId);
      },
      onAutoplayRequest: (guildId, count) => this.pickAutoplayTracks(guildId, count),
      // The session ledger follows the queue's owner: whose library and
      // dislikes the planner reads is decided here, not by whoever's request
      // happens to be the most recent.
      onListenerChange: (guildId, listenerId) => {
        void this.#autoplaySession?.setListener(guildId, listenerId).catch(() => undefined);
        logger.info({ event: 'AUTOPLAY_LISTENER', guildId, listenerId }, 'Autoplay listener set');
      },
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
        // Warm the buffer from the TASTE ANCHORS, not from whatever happens
        // to be playing. The old seed window here — the current track plus
        // the last few played, origin-blind — was the drift engine: once a
        // batch of recommendations played, they became the seeds, and every
        // subsequent batch orbited the previous one instead of the listener.
        // Anchor seeds come from history (user-originated plays as anchors),
        // with the current track joining as anchor or discounted context
        // according to who chose it. Async and fire-and-forget: the playback
        // path never waits on the history read.
        if (this.#autoplay !== undefined) {
          void this.#anchorSeeds(guildId, track)
            .then((seeds) => {
              if (seeds.length > 0) this.#autoplay?.prefetch(guildId, seeds);
            })
            .catch(() => undefined);
        }
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

    this.#players.set(options.guildId, guildPlayer);

    // Who is in the room, before anything can start playing. Without this a
    // player begins life assuming an audience, and a 24/7 restore into an
    // empty channel would start the music before the first voice-state event
    // arrived to say nobody is there.
    guildPlayer.onOccupancyChange(this.#listenerCountIn(options.voiceChannelId) > 0);

    // The room picks up where it left off. Deliberately before the first
    // event goes out, so the dashboard's opening snapshot already has the
    // restored list rather than an empty player it has to correct.
    if (saved !== null) {
      guildPlayer.queue.restore(saved.tracks, saved.currentIndex, saved.loopMode);
      this.#syncSessionQueue(options.guildId);
      if (saved.listenerId !== null) {
        void this.#autoplaySession
          ?.setListener(options.guildId, saved.listenerId)
          .catch(() => undefined);
      }
      this.#resumeNotices.set(options.guildId, {
        voiceChannelId: options.voiceChannelId,
        trackCount: saved.tracks.length,
      });
      logger.info(
        {
          guildId: options.guildId,
          channelId: options.voiceChannelId,
          tracks: saved.tracks.length,
        },
        'Resumed the queue this channel was left with',
      );
    }

    this.#emitEvent(options.guildId, 'PLAYER_CONNECT', guildPlayer.snapshot());

    logger.info({ guildId: options.guildId, channelId: options.voiceChannelId }, 'Player created');
    return guildPlayer;
  }

  /**
   * The queue a voice channel was left with, if it is worth bringing back.
   *
   * Never throws: a database that cannot answer means the room starts empty,
   * which is exactly what happened before channels had memories at all.
   */
  async #savedQueueFor(guildId: string, voiceChannelId: string): Promise<PersistedQueue | null> {
    try {
      const saved = await this.#store.loadPersisted(guildId, voiceChannelId);
      if (saved === null) return null;

      const age = Date.now() - saved.savedAt.getTime();
      if (age > QUEUE_RESUME_WINDOW_MS) {
        logger.debug(
          { guildId, voiceChannelId, ageMinutes: Math.round(age / 60_000) },
          'Saved queue is too old to resume; starting this channel clean',
        );
        return null;
      }
      return saved;
    } catch (error) {
      logger.warn({ err: error, guildId, voiceChannelId }, 'Reading a saved queue failed');
      return null;
    }
  }

  /**
   * What the last join brought back, consumed once.
   *
   * A command that joins asks for this so it can tell the room "your queue is
   * back" instead of leaving twelve unexplained songs sitting above the one
   * that was actually requested.
   */
  takeResumeNotice(guildId: string): ResumeNotice | null {
    const notice = this.#resumeNotices.get(guildId);
    if (notice === undefined) return null;
    this.#resumeNotices.delete(guildId);
    return notice;
  }

  /** Non-bot members currently in a voice channel; 0 when it cannot be read. */
  #listenerCountIn(voiceChannelId: string): number {
    const channel = this.#client.channels.cache.get(voiceChannelId);
    if (channel?.isVoiceBased() !== true) return 0;
    return channel.members.filter((member) => !member.user.bot).size;
  }

  /**
   * The same recording from a provider other than the one that just failed.
   *
   * Streams die for reasons that are provider-specific — YouTube refuses
   * label-owned music to anonymous clients, a SoundCloud upload gets taken
   * down — and until this existed that turned into "skipping" even when the
   * song was sitting on the other provider.
   *
   * The failed provider is read from `playbackSource`, not `source`: a track
   * the metadata layer identified displays as Spotify while its audio came from
   * SoundCloud or YouTube, and flipping away from "spotify" would pick a
   * provider at random. Metadata sources are never a target — they cannot
   * supply audio at all — so only the underlying stream is swapped and the
   * listener-facing identity stays exactly where it was.
   *
   * The replacement goes through the full matcher, not a bare search: the
   * fallback provider returns *something* for any query, and a remix or a
   * different song by the same artist is worse than admitting defeat.
   */
  async findAlternativeSource(
    track: QueuedTrack,
    failedSource: MusicSource,
  ): Promise<QueuedTrack | null> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return null;

    const failed = playbackSourceOf({
      source: failedSource,
      ...(track.playbackSource === undefined ? {} : { playbackSource: track.playbackSource }),
    });
    const alternative: PlaybackProvider = failed === 'soundcloud' ? 'youtube' : 'soundcloud';

    // Everything already known about the track becomes the canonical identity
    // the alternative is held to — including the runtime, which is the signal
    // that stops a fifteen-minute "full album" upload standing in for a song.
    const wanted = canonicalTrack({
      title: track.title,
      artist: track.author,
      durationMs: track.durationMs,
      provider:
        track.source === 'youtube' || track.source === 'soundcloud' ? 'query' : track.source,
      url: track.uri,
      artworkUrl: track.artworkUrl,
    });

    const resolved = await this.#resolvePlayable(node, wanted, {
      preference: alternative,
      bypassCache: true,
    }).catch((error: unknown) => {
      logger.debug({ err: error, title: track.title, provider: alternative }, 'Re-source failed');
      return null;
    });
    if (resolved === null) return null;

    const replacement = fromLavalinkTrack(resolved.candidate.track, {
      id: track.requestedById,
      name: track.requestedByName,
    });
    return {
      ...replacement,
      // Keep the listener-facing identity of the track they queued; only the
      // stream behind it changed.
      title: track.title,
      author: track.author,
      source: track.source,
      playbackSource: resolved.provider,
      artworkUrl: track.artworkUrl ?? replacement.artworkUrl,
      ...(track.origin === undefined ? {} : { origin: track.origin }),
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
  attachAutoplay(
    engine: AutoplayEngine,
    orchestrator: MusicOrchestrator,
    planner?: AutoplayPlanner,
  ): void {
    this.#autoplay = engine;
    this.#autoplaySession = engine.session;
    orchestrator.setResolver(async (candidate) => this.resolveCandidate(candidate));
    // The planner chooses canonical songs; this is where they become audio.
    // Two resolvers because the planner's two pools carry different evidence:
    // a known song has a runtime and a catalogue URL, a discovery has a name.
    planner?.setResolvers({
      resolveKnown: async (candidate) => this.resolveKnown(candidate),
      resolveDiscovery: async (candidate) => this.resolveCandidate(candidate),
      // The planner is handed a ledger of remembered listeners; only this
      // layer can say which of them are still in the room.
      presentListeners: (guildId, listenerIds) => this.#listenersInVoice(guildId, listenerIds),
    });
  }

  /**
   * The remembered listeners who are actually in the bot's voice channel.
   *
   * Personalisation has to follow people, not rows. The session ledger keeps
   * every requester and the persisted session owner, and in a guild running
   * 24/7 that memory outlives everyone leaving the channel — so autoplay went
   * on building a radio for someone who was no longer there. That is not just
   * stale: a person's library, dislikes and profile travel with them, so an
   * empty channel here was being tuned to what its absent owner was listening
   * to in a completely different server.
   *
   * Fails open. A channel the cache cannot resolve returns the ids unchanged,
   * because silently de-personalising a live session is worse than trusting a
   * ledger for one generation pass.
   */
  #listenersInVoice(guildId: string, listenerIds: readonly string[]): readonly string[] {
    if (listenerIds.length === 0) return listenerIds;

    const player = this.#players.get(guildId);
    if (player === undefined) return listenerIds;

    const channel = this.#client.channels.cache.get(player.voiceChannelId);
    if (channel?.isVoiceBased() !== true) return listenerIds;

    // `members` is derived from voice states, which the GuildVoiceStates
    // intent keeps current — this is the live occupancy of the channel, not a
    // message-cache artefact.
    const present = channel.members;
    const inRoom = listenerIds.filter((id) => present.has(id));
    if (inRoom.length !== listenerIds.length) {
      logger.debug(
        { guildId, remembered: listenerIds.length, present: inRoom.length },
        'Autoplay listeners narrowed to the voice channel',
      );
    }
    return inRoom;
  }

  /** A queue/history track as the session store sees it. */
  #sessionEntryOf(track: {
    readonly title: string;
    readonly author: string;
    readonly identifier: string;
    readonly sourceKey?: string;
    readonly requestedById?: string;
    readonly requestedByName?: string;
    readonly origin?: QueuedTrack['origin'];
    readonly autoplayKind?: QueuedTrack['autoplayKind'];
  }): SessionEntry {
    const identity = identityOf(track.author, track.title);
    const origin =
      track.requestedByName === undefined
        ? undefined
        : trackOrigin({
            requestedByName: track.requestedByName,
            ...(track.origin === undefined ? {} : { origin: track.origin }),
          });
    return {
      key: identity.key,
      identifier: track.identifier,
      artistKey: identity.artistKey,
      // Who put it on and, for autoplay's own picks, which pool it came from.
      // The planner reads these back to continue the familiar/discovery
      // rhythm across batches and to know whose library to draw from.
      ...(origin === undefined ? {} : { origin }),
      ...(track.autoplayKind === undefined ? {} : { kind: track.autoplayKind }),
      ...(origin === 'user' && track.requestedById !== undefined
        ? { requestedById: track.requestedById }
        : {}),
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
   * Runs the same matcher as a user request, so the vetoes that keep movie
   * scenes and reaction videos out of `/play` keep them out of autoplay too —
   * previously this took whichever result came back first and applied a much
   * weaker plausibility check.
   *
   * Two deliberate differences from the user-request path:
   *
   *   - **Duration is unknown.** A recommendation is a title and an artist,
   *     nothing more, so the single largest positive signal is unavailable and
   *     every score lands correspondingly lower. `AUTOPLAY_WEIGHTS` moves the
   *     threshold with it; the vetoes and filters are unchanged.
   *   - **The same provider order as a user request.** SoundCloud first,
   *     YouTube as the fallback, HTTP untouched. The recommendation engine
   *     never names a provider; it hands over a song and this decides where
   *     the audio comes from. (This once pinned YouTube so the mix fallback
   *     had video ids to seed from; that fallback is the last resort now and
   *     not worth playing every recommendation from the noisier catalogue.)
   */
  async resolveCandidate(candidate: {
    readonly title: string;
    readonly artist: string;
  }): Promise<QueuedTrack | null> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return null;

    const wanted = canonicalTrack({
      title: candidate.title,
      artist: candidate.artist,
      // Zero, not a guess: the matcher reads a non-positive runtime as "nothing
      // to compare" and skips the duration signal rather than scoring against a
      // fabricated one.
      durationMs: 0,
      provider: 'query',
    });

    const resolved = await resolvePlayback<LavalinkCandidate>(wanted, this.#providerSearch(node), {
      order: getResolutionSettings().order,
      weights: { youtube: AUTOPLAY_WEIGHTS, soundcloud: AUTOPLAY_WEIGHTS },
      duration: getResolutionSettings().duration,
      officialChannelTokens: getResolutionSettings().officialChannelTokens,
      cache: this.#resolutionCache,
    }).then(({ result }) => result);
    if (resolved === null) return null;

    const track: QueuedTrack = {
      ...fromLavalinkTrack(resolved.candidate.track, {
        id: this.#client.user?.id ?? '0',
        name: 'Autoplay',
      }),
      playbackSource: resolved.provider,
      // Recommendation-generated: history and future generations must treat
      // this play as context, never as user taste.
      origin: 'autoplay',
    };

    // Live streams and radio rips are not songs; long uploads are usually full
    // albums or hour-long mixes that would swallow the queue. The matcher
    // cannot apply this itself — with no canonical runtime it has nothing to
    // compare against — so autoplay keeps its own absolute bounds.
    if (track.isStream) return null;
    if (track.durationMs < 60_000 || track.durationMs > 900_000) return null;

    return track;
  }

  /**
   * Turn a song the listener already knows into something playable.
   *
   * Known songs come from the library, playlists and history, and those rows
   * carry what a bare recommendation lacks: a canonical runtime, and often
   * the catalogue URL and the title exactly as the catalogue spelled it. That
   * is the full evidence a user request has, so the match runs under the
   * ordinary weights and the ordinary SoundCloud → YouTube order — the stored
   * Lavalink blob and identifier are NOT replayed, because both go stale.
   *
   * Returns null when no provider has a confident match; the planner then
   * tries its next candidate rather than playing a doubtful upload.
   */
  async resolveKnown(candidate: FamiliarCandidate): Promise<QueuedTrack | null> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return null;

    const isCatalogue = candidate.source === 'spotify' || candidate.source === 'deezer';
    const wanted = canonicalTrack({
      title: candidate.title,
      artist: candidate.artist,
      durationMs: candidate.durationMs,
      provider: isCatalogue ? candidate.source : 'query',
      // Only a catalogue page is a canonical URL. A YouTube or SoundCloud
      // page is where the audio once came from, not what the song is.
      url: isCatalogue ? candidate.uri : null,
      artworkUrl: candidate.artworkUrl,
    });

    const resolved = await this.#resolvePlayable(node, wanted, {
      // No runtime on the row means the duration signal is unavailable, and
      // the autoplay threshold is the honest bar for that case — but a match
      // accepted under that lower bar must not be cached as THE answer for a
      // later /play of the same song.
      ...(candidate.durationMs > 0
        ? {}
        : { acceptScore: AUTOPLAY_WEIGHTS.acceptScore, bypassCache: true }),
    });
    if (resolved === null) return null;

    const track: QueuedTrack = {
      ...fromLavalinkTrack(resolved.candidate.track, {
        id: this.#client.user?.id ?? '0',
        name: 'Autoplay',
      }),
      // The listener knows this song by the stored identity, not by whatever
      // the upload is titled.
      title: candidate.title,
      author: candidate.artist,
      artworkUrl: candidate.artworkUrl ?? resolved.candidate.track.info.artworkUrl ?? null,
      uri: isCatalogue ? candidate.uri : (resolved.candidate.track.info.uri ?? candidate.uri),
      source: isCatalogue ? candidate.source : resolved.provider,
      playbackSource: resolved.provider,
      origin: 'autoplay',
    };

    if (track.isStream) return null;
    if (track.durationMs < 60_000 || track.durationMs > 900_000) return null;
    return track;
  }

  /**
   * An explicit "not like": remember it, and make sure the song is gone from
   * everywhere it could come back from — the queue, the prefetch buffer, and
   * the session's exclusion set — under its canonical identity, so the same
   * recording cannot return through another provider.
   *
   * Persistence is the caller's (the dislikes service) responsibility; this
   * is the live-player half. Skipping the currently playing track is left to
   * the caller too, because it is a voice action with its own permissions.
   */
  applyDislike(
    guildId: string,
    track: Pick<QueuedTrack, 'title' | 'author' | 'sourceKey'> | { readonly trackKey: string },
  ): {
    readonly key: string;
    readonly removedFromQueue: number;
    readonly evictedFromBuffer: number;
  } {
    // Callers arrive with either a queued track (Discord) or just the
    // canonical key (the dashboard, which only has the snapshot). Both
    // spellings of a queued song count: the upload's and, for a
    // recommendation, the candidate's it was picked as.
    const primaryKey =
      'trackKey' in track ? track.trackKey : identityOf(track.author, track.title).key;
    const keys = new Set([
      primaryKey,
      ...('trackKey' in track || track.sourceKey === undefined ? [] : [track.sourceKey]),
    ]);

    const player = this.#players.get(guildId);
    const removed =
      player === undefined
        ? []
        : player.removeUpcomingWhere((queued) => {
            const queuedIdentity = identityOf(queued.author, queued.title);
            return (
              keys.has(queuedIdentity.key) ||
              (queued.sourceKey !== undefined && keys.has(queued.sourceKey))
            );
          });
    // The removed uploads' own spellings join the exclusion so the session
    // recognises the song under every vocabulary it has been seen in.
    for (const gone of removed) {
      keys.add(identityOf(gone.author, gone.title).key);
      if (gone.sourceKey !== undefined) keys.add(gone.sourceKey);
    }

    const evicted = this.#autoplay?.evict(guildId, keys) ?? 0;
    void this.#autoplaySession?.recordDisliked(guildId, [...keys]).catch(() => undefined);

    logger.info(
      {
        event: 'AUTOPLAY_DISLIKE',
        guildId,
        track: 'trackKey' in track ? track.trackKey : `${track.author} — ${track.title}`,
        key: primaryKey,
        removedFromQueue: removed.length,
        evictedFromBuffer: evicted,
      },
      'Track disliked; removed from future autoplay',
    );
    return { key: primaryKey, removedFromQueue: removed.length, evictedFromBuffer: evicted };
  }

  /**
   * Whether a person has a say in a guild's live session: its primary
   * listener, or somebody whose request is in the queue. Gates the live half
   * of a dashboard dislike, which arrives with nothing but a guild id.
   */
  isSessionListener(guildId: string, discordId: string): boolean {
    const player = this.#players.get(guildId);
    if (player === undefined) return false;
    if (player.listenerId === discordId) return true;
    return player.queue.tracks.some(
      (track) => trackOrigin(track) === 'user' && track.requestedById === discordId,
    );
  }

  /** A dislike withdrawn: the session mirror must stop excluding the song. */
  forgetDislike(guildId: string, trackKey: string): void {
    void this.#autoplaySession?.forgetDisliked(guildId, [trackKey]).catch(() => undefined);
    logger.info({ event: 'AUTOPLAY_UNDISLIKE', guildId, key: trackKey }, 'Dislike withdrawn');
  }

  /** Drop a guild's prefetched autoplay buffer — on stop or disconnect. */
  clearAutoplayBuffer(guildId: string): void {
    this.#autoplay?.clear(guildId);
  }

  /**
   * Anchor-based seeds for one guild, optionally with the track that just
   * started prepended (it is not in history yet — its row is written when it
   * ends). One indexed query; the anchor selection itself is pure.
   */
  async #anchorSeeds(guildId: string, current?: QueuedTrack): Promise<readonly TrackSeed[]> {
    const history = await this.#store.recentHistory(guildId, 40);
    const entries: AnchorHistoryEntry[] = [
      ...(current === undefined
        ? []
        : [
            {
              title: current.title,
              author: current.author,
              identifier: current.identifier,
              origin: trackOrigin(current),
              skipped: false,
            },
          ]),
      ...history,
    ];
    return selectAutoplaySeeds(entries);
  }

  /**
   * One Lavalink search, whole result list, cached.
   *
   * Capped at {@link SEARCH_CANDIDATE_LIMIT}: YouTube's relevance ordering is
   * poor at picking the release but perfectly good at keeping it near the top,
   * so scoring the tail costs work without changing outcomes.
   */
  async #searchMany(
    node: Node,
    query: string,
    source: 'youtube' | 'soundcloud' = 'youtube',
  ): Promise<readonly LavalinkTrack[]> {
    // The prefix is part of the key: the same title on SoundCloud and YouTube
    // are different recordings, and a shared key would serve one for the other.
    const prefixed = buildSearchQuery(query, source);
    const cached = this.#searchCache.get(prefixed);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return cached.candidates;
      this.#searchCache.delete(prefixed);
    }

    const response = await node.rest.resolve(prefixed);
    if (response?.loadType !== LoadType.SEARCH) return [];
    const candidates = response.data.slice(0, SEARCH_CANDIDATE_LIMIT);

    if (this.#searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.#searchCache.keys().next();
      if (!(oldest.done ?? false)) this.#searchCache.delete(oldest.value);
    }
    this.#searchCache.set(prefixed, { candidates, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    return candidates;
  }

  /**
   * Search one playback provider, bound to a node.
   *
   * This is the seam the resolver is built around: it knows how to ask
   * Lavalink and nothing about which provider should be asked first or what
   * makes an answer acceptable. Both of those live in `playback-resolver.ts`,
   * where the canonical track is in scope.
   */
  #providerSearch(
    node: Node,
  ): (query: string, provider: PlaybackProvider) => Promise<readonly LavalinkCandidate[]> {
    return async (query, provider) => {
      const results = await this.#searchMany(node, query, provider);
      return results.map((track) => toCandidate(track));
    };
  }

  /**
   * The best playable upload for one canonical recording — SoundCloud first,
   * YouTube as the fallback.
   *
   * All of the policy lives in {@link resolvePlayback}; this only supplies the
   * node-bound search, the configured weights and the cache. A null return is a
   * real answer and means every provider was asked and none of them produced a
   * candidate worth playing.
   */
  async #resolvePlayable(
    node: Node,
    wanted: CanonicalTrack,
    options: {
      readonly preference?: PlaybackPreference;
      readonly requestedVariants?: ReadonlySet<string> | undefined;
      readonly acceptScore?: number | undefined;
      /**
       * Skip the resolution cache entirely. Set by stream recovery, which is by
       * definition reacting to a result that turned out to be unplayable:
       * reading the cache could hand back the dead entry, and writing to it
       * would publish a recovery pick as the canonical answer for every future
       * request.
       */
      readonly bypassCache?: boolean;
    } = {},
  ): Promise<ResolvedPlayback<LavalinkCandidate> | null> {
    const settings = getResolutionSettings();
    const preference = options.preference ?? 'auto';
    const { result } = await resolvePlayback<LavalinkCandidate>(
      wanted,
      this.#providerSearch(node),
      {
        // An explicitly chosen source pins the walk to that one provider; there
        // is no silent fall-through to somewhere the user did not ask for.
        order: preference === 'auto' ? settings.order : [preference],
        weights: settings.weights,
        duration: settings.duration,
        officialChannelTokens: settings.officialChannelTokens,
        requestedVariants: options.requestedVariants,
        acceptScore: options.acceptScore,
        ...(options.bypassCache === true ? {} : { cache: this.#resolutionCache }),
      },
    );
    return result;
  }

  /**
   * Turn one canonical recording into a queueable track.
   *
   * The metadata provider's identity is what the listener sees — title, artist,
   * artwork and, crucially, the URL — while the playback provider supplies only
   * the audio. A SoundCloud page must never become the public URL of a Spotify
   * track, and the display source must not change just because the stream came
   * from somewhere else. `playbackSource` records where the audio actually came
   * from, which is what the re-source path needs when a stream later dies.
   */
  #queuedFromResolution(
    resolved: ResolvedPlayback<LavalinkCandidate>,
    wanted: CanonicalTrack,
    requestedBy: { readonly id: string; readonly name: string },
    displaySource: MusicSource,
  ): QueuedTrack {
    const track = fromLavalinkTrack(resolved.candidate.track, requestedBy);
    return {
      ...track,
      title: wanted.title,
      author: joinedArtists(wanted),
      artworkUrl: wanted.artworkUrl ?? track.artworkUrl,
      uri: wanted.url ?? track.uri,
      source: displaySource,
      playbackSource: resolved.provider,
    };
  }

  /**
   * Map canonical metadata to playable matches, batch by batch.
   *
   * Work is done in batches of `SPOTIFY_RESOLVE_CONCURRENCY`: parallel within a
   * batch for throughput, batch-by-batch so `onBatch` receives tracks in queue
   * order and the queue grows while the earlier tracks are already playing.
   *
   * A track that no provider can match confidently is simply absent from the
   * batch. That is deliberate: a collection resolving 47 of 50 songs correctly
   * is a better outcome than 50 of 50 where three are the wrong recording.
   */
  async #matchSpotifyTracks(
    metadata: readonly SpotifyTrackMeta[],
    requestedBy: { readonly id: string; readonly name: string },
    onBatch?: (tracks: readonly QueuedTrack[]) => Promise<void>,
    preference: PlaybackPreference = 'auto',
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
    const perProvider = new Map<PlaybackProvider, number>();

    for (let offset = 0; offset < metadata.length; offset += batchSize) {
      const batch = metadata.slice(offset, offset + batchSize);
      const matched = await Promise.all(
        batch.map(async (meta): Promise<QueuedTrack | null> => {
          const wanted = canonicalFromSpotify(meta);
          try {
            const resolved = await this.#resolvePlayable(node, wanted, { preference });
            if (resolved === null) return null;
            perProvider.set(resolved.provider, (perProvider.get(resolved.provider) ?? 0) + 1);
            return this.#queuedFromResolution(resolved, wanted, requestedBy, 'spotify');
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
        // Which provider actually carried the collection. A sudden swing toward
        // YouTube is the first sign SoundCloud coverage or search has degraded.
        fromSoundcloud: perProvider.get('soundcloud') ?? 0,
        fromYoutube: perProvider.get('youtube') ?? 0,
        durationMs: Date.now() - startedAt,
        batchSize,
      },
      'Canonical → playback resolution complete',
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
    preference: PlaybackPreference = 'auto',
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
    await this.#matchSpotifyTracks(firstPage.slice(0, consumed), requestedBy, collect, preference);
    // The very first track can be unmatchable; widen until something plays.
    while (headTracks.length === 0 && consumed < firstPage.length) {
      const batch = firstPage.slice(consumed, consumed + batchSize);
      await this.#matchSpotifyTracks(batch, requestedBy, collect, preference);
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
          preference,
        );
        if (morePages === undefined) return fromFirstPage;

        const rest = await morePages;
        const fromRest = await this.#matchSpotifyTracks(rest, requestedBy, onTracks, preference);
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
  async pickAutoplayTracks(
    guildId: string,
    count: number = AUTOPLAY_PICK_TARGET,
  ): Promise<readonly QueuedTrack[]> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) return [];
    const wanted = Math.max(1, Math.min(count, AUTOPLAY_MAX_PICKS));

    const history = await this.#store.recentHistory(guildId, 40);
    // The very first song of a fresh guild is still playing when the low-
    // water refill first asks, and its history row is only written when it
    // ends. What is playing IS the session; it seeds until history exists —
    // and so does a restored queue whose history was pruned or unreadable:
    // the tracks it holds are what the room was listening to.
    const player = this.#players.get(guildId);
    const current = player?.queue.current ?? null;
    const queued: AnchorHistoryEntry[] =
      history.length > 0 || player === undefined
        ? []
        : [...player.queue.tracks]
            .reverse()
            .slice(0, 10)
            .map((track) => ({
              title: track.title,
              author: track.author,
              identifier: track.identifier,
              origin: trackOrigin(track),
              skipped: false,
            }));
    if (history.length === 0 && current === null && queued.length === 0) return [];

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
      // Anchor-based seeds: user-originated plays anchor the generation, the
      // newest autoplay play joins only as discounted context. Seeding from
      // the raw last-4 plays here — origin-blind — was the primary source of
      // taste drift.
      const seeds = selectAutoplaySeeds([
        ...(current === null
          ? []
          : [
              {
                title: current.title,
                author: current.author,
                identifier: current.identifier,
                origin: trackOrigin(current),
                skipped: false,
              },
            ]),
        ...history,
        ...queued,
      ]);

      const recommended = await engine.take(guildId, wanted, seeds);
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

    // Last-resort artist search seeds from the artists the USER played.
    const authorPool = history.filter((entry) => entry.origin === 'user' && !entry.skipped);
    const seedAuthors = [
      ...new Set(
        (authorPool.length > 0 ? authorPool : history)
          .slice(0, 8)
          .map((entry) => cleanAuthor(entry.author)),
      ),
    ]
      .filter((author) => author.length > 0)
      .slice(0, 3);

    const picks: QueuedTrack[] = [];
    const perAuthorCount = new Map<string, number>();
    const requester = { id: this.#client.user?.id ?? '0', name: 'Autoplay' };

    /** Keep a candidate only if it is fresh, playable and not over-represented. */
    const consider = (raw: LavalinkTrack): void => {
      if (picks.length >= wanted) return;
      const track: QueuedTrack = { ...fromLavalinkTrack(raw, requester), origin: 'autoplay' };

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

    // YouTube mixes are keyed by video id, so only plays whose identifier IS one
    // can seed them. That is a question about the *playback* provider, not the
    // catalogue: since SoundCloud became primary, a row displayed as Spotify
    // usually carries a SoundCloud id, and seeding a radio URL with it produces
    // a dead link. `playbackSource` answers it directly; rows predating that
    // column fall back to `source`, which was correct while YouTube was the
    // only provider — exactly the rows this is reading.
    const mixable = history.filter(
      (entry) =>
        playbackSourceOf({
          source: entry.source,
          ...(entry.playbackSource === null ? {} : { playbackSource: entry.playbackSource }),
        }) === 'youtube',
    );
    const userMixable = mixable.filter((entry) => entry.origin === 'user' && !entry.skipped);
    const mixSeeds = (userMixable.length > 0 ? userMixable : mixable).slice(0, 2);

    for (const seed of mixSeeds) {
      if (picks.length >= wanted) break;
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
      if (picks.length >= wanted) break;

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
    let sessions: readonly StayConnectedSession[];
    try {
      // One room per guild: the channel each was most recently playing in.
      // Its other channels keep their queues for whenever somebody starts the
      // bot in them again.
      sessions = await this.#store.stayConnectedSessions();
    } catch (error) {
      logger.warn({ err: error }, '24/7 restore query failed');
      return;
    }

    for (const { guildId, voiceChannelId } of sessions) {
      try {
        const persisted = await this.#store.loadPersisted(guildId, voiceChannelId);
        if (persisted === null) continue;

        const guild = this.#client.guilds.cache.get(guildId);
        if (guild === undefined) continue;
        const channel = guild.channels.cache.get(persisted.voiceChannelId);
        if (channel?.isVoiceBased() !== true) continue;

        // Who this radio is for comes back with the queue: the persisted
        // owner, or failing that the most recent person who requested one of
        // the restored tracks.
        const listener =
          persisted.listenerId ??
          [...persisted.tracks]
            .reverse()
            .find((track) => trackOrigin(track) === 'user' && track.requestedById !== '0')
            ?.requestedById ??
          null;
        const player = await this.getOrCreatePlayer({
          guildId,
          voiceChannelId: persisted.voiceChannelId,
          textChannelId: persisted.textChannelId,
          shardId: guild.shardId,
          listenerId: listener,
          // This path restores the queue itself, with its own cursor handling
          // (see the skip below); letting the join do it as well would apply
          // two different resume policies to one queue.
          resumeSavedQueue: false,
        });
        player.queue.restore(persisted.tracks, persisted.currentIndex, persisted.loopMode);
        await player.setVolume(persisted.volume);
        if (listener !== null) {
          void this.#autoplaySession?.setListener(guildId, listener).catch(() => undefined);
        }

        // Resume from the track after the last known one — the position within
        // the old track is stale by now, and skipping forward beats replaying.
        // The session mirror is synced AFTER the cursor moves, so its queued
        // set reflects what is actually still ahead. A queue that had already
        // reached its end does not stay silent: with autoplay on, the restored
        // listener's taste continues it.
        const next = player.queue.skip();
        this.#syncSessionQueue(guildId);
        if (!player.hasListeners) {
          // 24/7 means the bot waits in the channel, not that it performs to
          // an empty one. The queue is restored and parked; the first person
          // to walk in starts it (`GuildPlayer.onOccupancyChange`).
          logger.info(
            { guildId, tracks: persisted.tracks.length, listener },
            '24/7: rejoined an empty channel; queue parked until somebody joins',
          );
          continue;
        }
        if (next !== null) {
          await player.jumpTo(player.queue.currentIndex);
        } else if (player.autoplayEnabled) {
          const resumed = await player.resumeAutoplay();
          logger.info(
            { guildId, resumed, listener },
            '24/7: restored queue was finished; autoplay asked to continue',
          );
        }

        logger.info(
          { guildId, tracks: persisted.tracks.length, listener },
          '24/7: rejoined voice and restored the queue',
        );
      } catch (error) {
        logger.warn({ err: error, guildId }, '24/7 restore failed for this guild');
      }
    }
  }

  #emitEvent(guildId: string, type: PlayerEventType, state: PlayerSnapshot | null): void {
    // Encoded once and used twice: the live broadcast and the retained copy
    // must be byte-identical, and a second `Date.now()` would make them differ.
    const payload = encodePlayerEvent({ type, guildId, sentAt: Date.now(), state });
    this.#publishEvent?.(payload);
    // A null state means the player is gone, so the retained snapshot must go
    // with it rather than leave the dashboard greeting new tabs with a ghost.
    this.#retainEvent?.(guildId, state === null ? null : payload);
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
    // A resume nobody asked about does not survive the session it belongs to.
    this.#resumeNotices.delete(guildId);
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
   * Two questions, asked in that order, and the whole architecture is that
   * order: *what song is this?*, then *which upload most accurately is it?*
   *
   *   1. **Identity.** Spotify first (it alone can answer with an album, an
   *      artist or a playlist), then Deezer, then Apple Music. The winner
   *      becomes a `CanonicalTrack` — title, every credited artist, album,
   *      runtime and, where the catalogue exposes one, an ISRC. The listener
   *      keeps that identity: the catalogue's title, artwork and URL, never
   *      the playback provider's page.
   *   2. **Playback.** SoundCloud first, YouTube as the fallback, each with
   *      multiple candidates filtered, scored and ranked against the canonical
   *      track. Nothing plays unless it clears that provider's confidence
   *      threshold.
   *
   * A URL bypasses step 1 entirely — the user already said which object they
   * meant — which is what keeps YouTube, SoundCloud, Apple Music and direct
   * HTTP links behaving exactly as before.
   *
   * `source` pins step 2 to one provider when the user chose one; step 1 still
   * runs, because knowing what the song is makes the match better regardless of
   * where it comes from.
   *
   * @throws {NotFoundError} No provider had a match good enough to play. This
   *   is a real outcome, not a bug: a wrong song is worse than an honest miss.
   * @throws {ValidationError} Lavalink rejected the input.
   * @throws {UpstreamError} No node available or the node errored.
   */
  async resolve(
    input: string,
    requestedBy: { readonly id: string; readonly name: string },
    source: PlaybackPreference = 'auto',
  ): Promise<ResolveResult> {
    const node = this.shoukaku.getIdealNode();
    if (node === undefined) {
      throw new UpstreamError('The music server is not available right now. Try again shortly.');
    }

    // Spotify links: metadata from the Web API, audio via the playback layer —
    // Spotify audio itself is never streamed.
    if (isSpotifyUrl(input)) {
      return this.#resolveSpotify(input, requestedBy, source);
    }
    if (isSpotifyWebUrl(input)) {
      throw new ValidationError('Unsupported or invalid Spotify link.');
    }

    // A URL names a specific object. There is no identity question to answer —
    // the user already answered it — so it goes straight to Lavalink, which is
    // what keeps YouTube links, SoundCloud links, Apple Music links (through
    // LavaSrc) and plain HTTP audio working exactly as they always have.
    if (/^https?:\/\//iu.test(input.trim())) {
      return this.#resolveDirect(node, input, requestedBy, source);
    }

    // Free text. Identity first, playback second — see `canonical-track.ts`.
    const requestedVariants = requestedVariantsOf(input);

    // Spotify is the canonical catalogue and the only one of the three that
    // can answer with an album, an artist or a playlist rather than a single
    // track, so it keeps its own path.
    const hit = await searchSpotifyBest(input);
    if (hit !== null) {
      try {
        return await this.#resolveSpotify(hit.url, requestedBy, source);
      } catch (error) {
        // The catalogue had a match but nothing playable came of it. The other
        // metadata providers still get their turn below.
        logger.debug(
          { err: error, query: input, kind: hit.kind, name: hit.name },
          'Spotify-first resolution fell through',
        );
      }
    }

    // Deezer, then Apple Music. Deezer is asked first because it is the only
    // one of the three that exposes an ISRC, and an identification carrying the
    // strongest identifier is worth more than one that does not.
    const identified = await identifyCanonicalTrack(input).catch((error: unknown) => {
      logger.debug({ err: error, query: input }, 'Metadata identification failed');
      return null;
    });
    if (identified !== null) {
      const track = await this.#resolveIdentified(node, identified, requestedBy, {
        preference: source,
        requestedVariants,
      });
      if (track !== null) return { tracks: [track], playlistName: null };
      logger.debug(
        { query: input, identifiedAs: describeCanonical(identified) },
        'Identified the track but no provider had a confident match',
      );
    }

    // Nothing identified it. The query itself becomes the canonical identity —
    // weaker evidence, so the threshold drops with it — but the candidates are
    // still filtered, scored and ranked. "Whatever came back first" is not a
    // fallback this architecture has.
    const fromQuery = canonicalTrack({
      title: input.trim(),
      artist: '',
      durationMs: 0,
      provider: 'query',
    });
    const track = await this.#resolveIdentified(node, fromQuery, requestedBy, {
      preference: source,
      requestedVariants,
      // No catalogue, no runtime and no artist: three of the strongest signals
      // are simply absent, so holding this to the full threshold would reject
      // everything. The vetoes and the ranking are unchanged.
      acceptScore: UNIDENTIFIED_ACCEPT_SCORE,
    });
    if (track !== null) return { tracks: [track], playlistName: null };

    throw new NotFoundError('No reliable playable version of that track was found.');
  }

  /**
   * Resolve an identified recording to a single queueable track.
   *
   * @returns null when no playback provider produced a confident match. The
   *   caller decides what that means — another metadata provider, or an honest
   *   failure — but it never means "play the best of a bad set".
   */
  async #resolveIdentified(
    node: Node,
    wanted: CanonicalTrack,
    requestedBy: { readonly id: string; readonly name: string },
    options: {
      readonly preference: PlaybackPreference;
      readonly requestedVariants?: ReadonlySet<string> | undefined;
      readonly acceptScore?: number | undefined;
    },
  ): Promise<QueuedTrack | null> {
    const resolved = await this.#resolvePlayable(node, wanted, options);
    if (resolved === null) return null;

    // Which catalogue's identity the listener sees.
    //
    // Deezer has its own place in the source enum, so a Deezer-identified track
    // displays as Deezer and links to its Deezer page. Apple Music does not —
    // adding one is a database migration — so an Apple-identified track keeps
    // the canonical title, artist and artwork but displays as, and links to,
    // the provider that actually streamed it. A track labelled "youtube"
    // carrying an Apple Music URL would be worse than either. The Apple link is
    // not lost: `platform-links` surfaces it in the now-playing embed.
    const identity: CanonicalTrack =
      wanted.provider === 'query'
        ? // Nothing identified this, so there is no catalogue identity to
          // impose — the upload's own title and artist are the best available
          // description of what is about to play.
          {
            ...wanted,
            title: resolved.candidate.title,
            primaryArtist: resolved.candidate.author,
            artists: [resolved.candidate.author],
            url: null,
            artworkUrl: null,
          }
        : wanted.provider === 'apple-music'
          ? { ...wanted, url: null }
          : wanted;
    const displaySource: MusicSource = wanted.provider === 'deezer' ? 'deezer' : resolved.provider;

    return this.#queuedFromResolution(resolved, identity, requestedBy, displaySource);
  }

  /**
   * A URL, handed to Lavalink unchanged.
   *
   * Untouched by the matcher on purpose: the user named the exact object, and
   * second-guessing an explicit link is not this system's job. This is also the
   * path that keeps direct HTTP audio playable.
   */
  async #resolveDirect(
    node: Node,
    input: string,
    requestedBy: { readonly id: string; readonly name: string },
    source: PlaybackPreference,
  ): Promise<ResolveResult> {
    const searchSource: PlaybackProvider = source === 'soundcloud' ? 'soundcloud' : 'youtube';

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

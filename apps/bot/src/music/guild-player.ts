/**
 * Per-guild playback controller.
 *
 * Owns one Shoukaku `Player` plus its `TrackQueue`, translates player events
 * into queue transitions, announces tracks, records history, persists the
 * queue, and manages the idle timer that leaves empty channels.
 */
import {
  LIMITS,
  type LoopMode,
  type MusicSource,
  type PlayerEventType,
  type PlayerSnapshot,
} from '@discord-music/shared';
import { EmbedBuilder, type Client } from 'discord.js';
import type { FilterOptions, Player } from 'shoukaku';

import { getLogger, type Logger } from '../lib/logger.js';
import type { FilterPresetName } from './filters.js';
import type { QueueStore } from './queue-store.js';
import {
  hasAnyLink,
  NO_PLATFORM_LINKS,
  renderPlatformLinks,
  type PlatformLinks,
} from './platform-links.js';
import { identityOf } from '../ai/identity.js';
import { formatTrackDuration, trackLink, trackOrigin, type QueuedTrack } from './track.js';
import { TrackQueue } from './track-queue.js';

/**
 * Cap on the logged `cause`. Lavalink stringifies the whole Java throwable, and
 * for a multi-client YouTube failure that is several lines listing what each
 * client said — worth keeping, but not worth an unbounded log line.
 */
const CAUSE_LOG_LIMIT = 600;

/**
 * How long the now-playing announcement waits for cross-platform links.
 * Past this the embed goes out without them rather than arriving late.
 */
const LINK_WAIT_MS = 2_500;

/** Refill thresholds when the manager passes none (tests, legacy callers). */
const DEFAULT_LOW_WATER_MARK = 2;
const DEFAULT_TARGET_QUEUE_SIZE = 4;
/** How long a failed drain-time autoplay attempt waits before its one retry. */
const AUTOPLAY_RETRY_DELAY_MS = 5_000;
/**
 * A refill request that has not answered by now is treated as failed. Without
 * a deadline one hung provider call would leave the in-flight marker set for
 * the life of the player and every later drain would end the queue.
 */
const AUTOPLAY_REQUEST_TIMEOUT_MS = 45_000;
/**
 * How long the drain path waits for the history write before generating.
 * Autoplay wants the just-finished track visible in history, but a slow
 * database must not turn into a gap of silence.
 */
const HISTORY_WAIT_MS = 2_500;

/**
 * How far short of its advertised runtime a "finished" track may fall before we
 * stop believing it finished.
 *
 * Lavalink reports a stream that hit end-of-file as `finished`, and it cannot
 * tell the difference between a song that ended and a source that stopped
 * sending — from the decoder's side both are EOF. That is how a 30-second
 * SoundCloud preview of a four-minute track, or a YouTube stream that dies
 * after four seconds, arrived here as a natural completion and quietly advanced
 * the queue. To the listener it looks exactly like an unexplained skip.
 *
 * Both bounds must be exceeded, so neither fires on its own: a track has to
 * miss a real fraction of its length AND a meaningful number of seconds. That
 * keeps ordinary end-of-file imprecision — a trailing silent frame, a container
 * whose duration is rounded up — from being read as a failure.
 */
const TRUNCATION_RATIO = 0.9;
const TRUNCATION_ABSOLUTE_MS = 15_000;

/**
 * Whether a track Lavalink called "finished" actually played through.
 *
 * Exported and pure because it is the load-bearing judgement in the whole
 * failure path: get it wrong in one direction and broken streams keep being
 * silently skipped past, get it wrong in the other and every normal song ending
 * triggers a pointless re-source.
 */
export function isTruncatedPlayback(input: {
  readonly reason: string;
  readonly expectedMs: number;
  readonly reachedMs: number;
  readonly isStream?: boolean;
}): boolean {
  // Only a claimed completion can be a false completion. Every other reason
  // already says what happened.
  if (input.reason !== 'finished') return false;
  // A livestream has no runtime to fall short of.
  if (input.isStream === true) return false;
  if (input.expectedMs <= 0) return false;
  return (
    input.reachedMs < input.expectedMs * TRUNCATION_RATIO &&
    input.expectedMs - input.reachedMs > TRUNCATION_ABSOLUTE_MS
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}… (truncated)`;
}

/**
 * The exception class name from Lavalink's stringified throwable, so failures
 * can be grouped by type without parsing the whole message at read time.
 */
function exceptionTypeOf(cause: string | undefined): string | undefined {
  const [firstLine] = (cause ?? '').split('\n');
  const match = /^([\w$]+(?:\.[\w$]+)*(?:Exception|Error))\b/u.exec(firstLine?.trim() ?? '');
  return match?.[1];
}

export interface GuildPlayerOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly player: Player;
  readonly client: Client;
  readonly store: QueueStore;
  readonly announce: boolean;
  readonly initialVolume: number;
  /** Seconds of inactivity before the player disconnects itself. */
  readonly idleTimeoutSeconds: number;
  /** 24/7 mode: never self-destruct on inactivity. */
  readonly stayConnected: boolean;
  /** Smart autoplay: ask for more tracks when the queue drains. */
  readonly autoplayEnabled: boolean;
  /** Discord id of the primary listener, when restored from a persisted queue. */
  readonly listenerId?: string | null;
  /**
   * Called when the primary listener changes — first request, a claim, or a
   * restore — so the session ledger follows the queue's owner.
   */
  readonly onListenerChange?: (guildId: string, listenerId: string | null) => void;
  /**
   * Queue refill thresholds. When the upcoming count is at or below the
   * low-water mark a refill starts; it fills back up to the target. Refilling
   * early is what keeps "queue ended" from ever being the normal case — the
   * queue never gets a chance to drain while autoplay can produce music.
   */
  readonly autoplayLowWaterMark?: number;
  readonly autoplayTargetQueueSize?: number;
  /** Called when the player wants to be torn down (idle timeout, fatal error). */
  readonly onSelfDestruct: (guildId: string, reason: string) => Promise<void>;
  /**
   * Called when the queue runs low or drains with autoplay enabled, asking
   * for up to `count` tracks. Returns tracks to continue with (may be
   * shorter, or empty — the player then parks only if the queue is drained).
   */
  readonly onAutoplayRequest: (guildId: string, count: number) => Promise<readonly QueuedTrack[]>;
  /**
   * Called when a track starts — EVERY track, not only with autoplay on: the
   * session ledger must see manual plays too, or the anti-repeat window has
   * holes exactly where the listener was most engaged. Must return
   * immediately — the playback path never waits.
   */
  readonly onTrackStarted?: (guildId: string, track: QueuedTrack) => void;
  /**
   * Called when a track finishes or is skipped, with how much of it actually
   * played. This is where recommendation outcomes (completed/skipped) come
   * from. Must return immediately.
   */
  readonly onTrackFinished?: (
    guildId: string,
    track: QueuedTrack,
    outcome: { readonly skipped: boolean; readonly playedMs: number },
  ) => void;
  /**
   * Find the same recording on a source other than the one that just refused to
   * play it. Returns null when nothing equivalent exists.
   */
  readonly onFindAlternative?: (
    track: QueuedTrack,
    failedSource: MusicSource,
  ) => Promise<QueuedTrack | null>;
  /** Cross-platform "listen on" links for the track that just started. */
  readonly onResolveLinks?: (track: QueuedTrack) => Promise<PlatformLinks>;
  /** Fire-and-forget realtime event sink (Redis → dashboard SSE). */
  readonly onEvent?: (type: PlayerEventType, state: PlayerSnapshot | null) => void;
}

export class GuildPlayer {
  readonly queue = new TrackQueue(LIMITS.QUEUE_MAX_TRACKS);
  readonly guildId: string;

  #voiceChannelId: string;
  readonly #textChannelId: string;
  readonly #player: Player;
  readonly #client: Client;
  readonly #store: QueueStore;
  readonly #logger: Logger;
  readonly #onSelfDestruct: (guildId: string, reason: string) => Promise<void>;

  #announce: boolean;
  #volume: number;
  #idleTimeoutSeconds: number;
  #idleTimer: NodeJS.Timeout | undefined;
  #trackStartedAt = 0;
  /** Whether a track is actually playing right now. See `isPlaying`. */
  #playing = false;
  /**
   * Why the next track-end should advance with `skip()` instead of `advance()`.
   * The DISTINCTION matters for learning: `/skip` is a rejection of the song
   * and feeds the skip penalty; `/jump` and `/previous` are navigation and say
   * nothing bad about the track they happen to leave.
   */
  #advanceIntent: 'skip' | 'jump' | null = null;
  #destroyed = false;
  #stayConnected: boolean;
  #autoplayEnabled: boolean;
  /**
   * The primary listener: whose history, library, playlists and dislikes
   * autoplay follows. Set by the first person to request a track, changed by
   * `/autoplay claim`, persisted with the queue and restored with it.
   */
  #listenerId: string | null;
  readonly #onListenerChange: ((guildId: string, listenerId: string | null) => void) | undefined;
  /**
   * The refill (low-water or drain) currently running, or null. A promise
   * rather than a flag so the drain path can WAIT for a refill that is
   * already on its way instead of misreading "busy" as "exhausted".
   */
  #autoplayInFlight: Promise<void> | null = null;
  /** Drain-time attempts that threw since the last track started. Bounds the retry. */
  #autoplayRetries = 0;
  /**
   * `#handleTrackEnd` is between clearing `#playing` and starting the next
   * track. A refill landing in that window must not auto-start playback:
   * `current` still points at the track that just ended, and the end
   * handler is about to advance and start the right one itself.
   */
  #endInFlight = false;
  #activeFilter: FilterPresetName | 'speed' | 'pitch' | null = null;
  readonly #onAutoplayRequest: (guildId: string, count: number) => Promise<readonly QueuedTrack[]>;
  readonly #autoplayLowWaterMark: number;
  readonly #autoplayTargetQueueSize: number;
  /** A drain-time autoplay attempt that threw gets exactly one delayed retry. */
  #autoplayRetryTimer: NodeJS.Timeout | undefined;
  readonly #onTrackStarted: ((guildId: string, track: QueuedTrack) => void) | undefined;
  readonly #onTrackFinished:
    | ((
        guildId: string,
        track: QueuedTrack,
        outcome: { readonly skipped: boolean; readonly playedMs: number },
      ) => void)
    | undefined;
  readonly #onFindAlternative:
    ((track: QueuedTrack, failedSource: MusicSource) => Promise<QueuedTrack | null>) | undefined;
  readonly #onResolveLinks: ((track: QueuedTrack) => Promise<PlatformLinks>) | undefined;
  /** Links for the playing track, refreshed on every track start. */
  #currentLinks: PlatformLinks = NO_PLATFORM_LINKS;
  /**
   * Identifiers already re-sourced once. A track gets exactly one alternative:
   * without this, a song missing everywhere would bounce between sources.
   */
  readonly #reSourced = new Set<string>();
  /** Set by the exception handler so the following `end` can recover instead of skipping. */
  /**
   * A playback failure Lavalink reported *before* the 'end' event that follows
   * it. Set by the exception and stuck handlers; read once by the end handler,
   * which is the only place with the queue context to act on it.
   */
  #failureBeforeEnd: 'exception' | 'stuck' | null = null;
  /**
   * Set by `stop()` so the `end` it provokes does not start autoplay.
   *
   * Stopping empties the queue, and an empty queue is exactly the condition
   * autoplay exists to answer — so without this, `/stop` handed straight over
   * to the radio and the music never actually stopped.
   */
  #stopRequested = false;
  readonly #onEvent: ((type: PlayerEventType, state: PlayerSnapshot | null) => void) | undefined;

  constructor(options: GuildPlayerOptions) {
    this.guildId = options.guildId;
    this.#voiceChannelId = options.voiceChannelId;
    this.#textChannelId = options.textChannelId;
    this.#player = options.player;
    this.#client = options.client;
    this.#store = options.store;
    this.#announce = options.announce;
    this.#volume = options.initialVolume;
    this.#idleTimeoutSeconds = options.idleTimeoutSeconds;
    this.#stayConnected = options.stayConnected;
    this.#autoplayEnabled = options.autoplayEnabled;
    this.#listenerId = options.listenerId ?? null;
    this.#onListenerChange = options.onListenerChange;
    this.#autoplayLowWaterMark = Math.max(
      1,
      options.autoplayLowWaterMark ?? DEFAULT_LOW_WATER_MARK,
    );
    this.#autoplayTargetQueueSize = Math.max(
      this.#autoplayLowWaterMark + 1,
      options.autoplayTargetQueueSize ?? DEFAULT_TARGET_QUEUE_SIZE,
    );
    this.#onSelfDestruct = options.onSelfDestruct;
    this.#onAutoplayRequest = options.onAutoplayRequest;
    this.#onTrackStarted = options.onTrackStarted;
    this.#onTrackFinished = options.onTrackFinished;
    this.#onFindAlternative = options.onFindAlternative;
    this.#onResolveLinks = options.onResolveLinks;
    this.#onEvent = options.onEvent;
    this.#logger = getLogger('guild-player').child({ guildId: options.guildId });

    this.#attachPlayerEvents();
  }

  /* ---------------------------------------------------------------- getters */

  get voiceChannelId(): string {
    return this.#voiceChannelId;
  }

  set voiceChannelId(channelId: string) {
    const moved = this.#voiceChannelId !== channelId;
    this.#voiceChannelId = channelId;
    if (moved) this.#emit('VOICE_MOVE');
  }

  get volume(): number {
    return this.#volume;
  }

  get paused(): boolean {
    return this.#player.paused;
  }

  get positionMs(): number {
    return this.#player.position;
  }

  get isPlaying(): boolean {
    // Tracked explicitly rather than read from `#player.track`: shoukaku never
    // clears `track` on a natural TrackEndEvent (only stopTrack/clean do), so
    // the player object reports "playing" forever after a song finishes on its
    // own. That stale value made `enqueue` refuse to start playback for
    // autoplay top-ups — the tracks were added and then silently parked.
    return this.#playing;
  }

  get stayConnected(): boolean {
    return this.#stayConnected;
  }

  /** 24/7 mode. Enabling cancels any pending idle disconnect immediately. */
  setStayConnected(enabled: boolean): void {
    this.#stayConnected = enabled;
    if (enabled) {
      this.#clearIdleTimer();
    } else if (!this.isPlaying) {
      this.#startIdleTimer();
    }
    this.#emit('STAY_CONNECTED_CHANGE');
  }

  /** Discord id of the primary listener, or null before anyone has requested. */
  get listenerId(): string | null {
    return this.#listenerId;
  }

  /**
   * Change the primary listener. Explicit — a claim, or a restore — so a
   * room's radio only changes hands on purpose, never because somebody else
   * happened to request the latest song.
   */
  setListener(listenerId: string | null): void {
    if (this.#listenerId === listenerId) return;
    this.#listenerId = listenerId;
    this.#onListenerChange?.(this.guildId, listenerId);
    this.#persist();
    this.#emit('LISTENER_CHANGE');
  }

  /**
   * Resume autoplay on a parked player — the restore path, when the saved
   * queue had nothing left to play. Returns true when music started.
   */
  async resumeAutoplay(): Promise<boolean> {
    if (this.isPlaying) return true;
    const outcome = await this.#tryAutoplay();
    if (outcome === 'continued') this.#clearIdleTimer();
    return outcome === 'continued';
  }

  get autoplayEnabled(): boolean {
    return this.#autoplayEnabled;
  }

  setAutoplayEnabled(enabled: boolean): void {
    this.#autoplayEnabled = enabled;
    this.#emit('AUTOPLAY_CHANGE');
    // Switched on mid-session: fill the queue now rather than waiting for
    // the current track to end.
    if (!enabled) return;
    if (this.isPlaying) {
      this.#maintainAutoplay();
    } else if (this.queue.upcoming.length === 0) {
      // The most likely moment to switch autoplay on is right after "queue
      // finished". A parked player has nothing to top up; it needs restarting.
      void this.#tryAutoplay().then((outcome) => {
        if (outcome === 'continued') this.#clearIdleTimer();
      });
    }
  }

  /** Configured refill thresholds, for diagnostics and tests. */
  get autoplayThresholds(): { readonly lowWaterMark: number; readonly targetQueueSize: number } {
    return {
      lowWaterMark: this.#autoplayLowWaterMark,
      targetQueueSize: this.#autoplayTargetQueueSize,
    };
  }

  /** The filter preset currently applied, or null for clean playback. */
  get activeFilter(): FilterPresetName | 'speed' | 'pitch' | null {
    return this.#activeFilter;
  }

  /* ---------------------------------------------------------------- control */

  /** Add tracks and start playback if nothing is playing. */
  async enqueue(
    tracks: readonly QueuedTrack[],
    options: { readonly next?: boolean } = {},
  ): Promise<{ position: number; startedPlayback: boolean }> {
    const position = this.queue.add(tracks, options);
    // The first person to put music on owns the session until somebody
    // claims it. Autoplay's own picks and restored placeholders never do.
    if (this.#listenerId === null) {
      const requester = tracks.find(
        (track) => trackOrigin(track) === 'user' && /^\d{15,22}$/u.test(track.requestedById),
      );
      if (requester !== undefined) this.setListener(requester.requestedById);
    }
    this.#persist();
    this.#emit('QUEUE_UPDATE');

    if (!this.isPlaying && !this.#endInFlight) {
      // After the queue drains, the cursor parks at the old length — exactly
      // where `add` just placed the first new track, so `current` is already
      // it. Calling `advance()` from there would move to the SECOND new track:
      // the first would be announced, never played, never recorded in history,
      // and (being the top-scoring pick) re-recommended on every autoplay
      // cycle. On a fresh queue `current` is null and `advance()` is correct.
      const first = this.queue.current ?? this.queue.advance() ?? this.queue.jumpTo(position);
      if (first !== null) {
        await this.#playTrack(first);
        return { position, startedPlayback: true };
      }
    }

    return { position, startedPlayback: false };
  }

  /** Skip the current track. Resolves to the next track, or null if drained. */
  async skip(): Promise<QueuedTrack | null> {
    this.#advanceIntent = 'skip';
    // stopTrack fires the 'end' event (reason: stopped); advancement happens there.
    await this.#player.stopTrack();
    return this.queue.current;
  }

  async jumpTo(index: number): Promise<QueuedTrack | null> {
    const target = this.queue.jumpTo(index);
    if (target === null) return null;
    this.#advanceIntent = 'jump';
    await this.#playTrack(target);
    this.#persist();
    return target;
  }

  /** Go back to the previously played track. Null when at the start. */
  async previous(): Promise<QueuedTrack | null> {
    const target = this.queue.previous();
    if (target === null) return null;
    this.#advanceIntent = 'jump';
    await this.#playTrack(target);
    this.#persist();
    return target;
  }

  /** Restart the current track from the beginning. */
  async restart(): Promise<QueuedTrack | null> {
    const track = this.queue.current;
    if (track === null) return null;
    if (this.isPlaying) {
      await this.#player.seekTo(0);
    } else {
      await this.#playTrack(track);
    }
    return track;
  }

  moveUpcoming(from: number, to: number): QueuedTrack | null {
    const moved = this.queue.moveUpcoming(from, to);
    if (moved !== null) {
      this.#persist();
      this.#emit('QUEUE_REORDER');
    }
    return moved;
  }

  swapUpcoming(a: number, b: number): boolean {
    const swapped = this.queue.swapUpcoming(a, b);
    if (swapped) {
      this.#persist();
      this.#emit('QUEUE_REORDER');
    }
    return swapped;
  }

  /** Apply a filter preset (replacing any active one), or clear with null. */
  async setFilter(
    name: FilterPresetName | 'speed' | 'pitch' | null,
    filters: FilterOptions,
  ): Promise<void> {
    if (name === null) {
      await this.#player.clearFilters();
    } else {
      // clearFilters first so presets replace instead of stack.
      await this.#player.clearFilters();
      await this.#player.setFilters(filters);
    }
    this.#activeFilter = name;
    this.#emit('FILTER_CHANGE');
  }

  async pause(): Promise<void> {
    await this.#player.setPaused(true);
    this.#persist();
    this.#emit('TRACK_PAUSE');
  }

  async resume(): Promise<void> {
    await this.#player.setPaused(false);
    this.#persist();
    this.#emit('TRACK_RESUME');
  }

  async setVolume(volume: number): Promise<void> {
    this.#volume = volume;
    await this.#player.setGlobalVolume(volume);
    this.#persist();
    this.#emit('VOLUME_CHANGE');
  }

  async seekTo(positionMs: number): Promise<void> {
    await this.#player.seekTo(positionMs);
    this.#emit('SEEK');
  }

  setLoopMode(mode: LoopMode): void {
    this.queue.loopMode = mode;
    this.#persist();
    this.#emit('LOOP_CHANGE');
  }

  shuffle(): void {
    this.queue.shuffle();
    this.#persist();
    this.#emit('QUEUE_REORDER');
  }

  removeUpcoming(upcomingIndex: number): QueuedTrack | null {
    const removed = this.queue.removeUpcoming(upcomingIndex);
    if (removed !== null) {
      this.#persist();
      this.#emit('QUEUE_UPDATE');
      this.#maintainAutoplay();
    }
    return removed;
  }

  /**
   * Remove every upcoming track matching `predicate` — an explicit dislike
   * pulls the song out of the queue wherever it sits, under any spelling.
   * Returns what was removed so the caller can report it.
   */
  removeUpcomingWhere(predicate: (track: QueuedTrack) => boolean): readonly QueuedTrack[] {
    const removed: QueuedTrack[] = [];
    // Walk from the back so indices ahead of the cursor stay valid.
    for (let index = this.queue.upcoming.length - 1; index >= 0; index -= 1) {
      const track = this.queue.upcoming[index];
      if (track !== undefined && predicate(track)) {
        const gone = this.queue.removeUpcoming(index);
        if (gone !== null) removed.push(gone);
      }
    }
    if (removed.length > 0) {
      this.#persist();
      this.#emit('QUEUE_UPDATE');
      this.#maintainAutoplay();
    }
    return removed.reverse();
  }

  clearUpcoming(): number {
    const removed = this.queue.clearUpcoming();
    if (removed > 0) {
      this.#persist();
      this.#emit('QUEUE_CLEAR');
      this.#maintainAutoplay();
    }
    return removed;
  }

  /** Stop playback and clear the queue, but stay connected. */
  async stop(): Promise<void> {
    this.queue.reset();
    // 'jump', not 'skip': ending the session says nothing bad about the song
    // that happened to be playing, and must not feed the skip penalty.
    this.#advanceIntent = 'jump';
    // Only a stop that actually ends a track produces the `end` event that
    // consumes this flag. Set it on an idle player and it would linger to
    // silently cancel autoplay at the next natural drain.
    this.#stopRequested = this.isPlaying;
    await this.#player.stopTrack();
    this.#persist();
    this.#startIdleTimer();
    this.#emit('QUEUE_CLEAR');
  }

  /** Full teardown. Called by the manager on disconnect. */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#playing = false;
    this.#emit('PLAYER_DISCONNECT');

    this.#clearIdleTimer();
    if (this.#autoplayRetryTimer !== undefined) {
      clearTimeout(this.#autoplayRetryTimer);
      this.#autoplayRetryTimer = undefined;
    }
    this.#player.removeAllListeners();
    await this.#store.flush(this.guildId, this.queue, this.paused, this.#listenerId, {
      voiceChannelId: this.#voiceChannelId,
      textChannelId: this.#textChannelId,
    });
  }

  /** Voice-state hook: the bot is alone (or not) in its channel. */
  onOccupancyChange(listenersPresent: boolean): void {
    if (listenersPresent) {
      this.#clearIdleTimer();
    } else {
      this.#startIdleTimer();
    }
  }

  /* ----------------------------------------------------------------- events */

  #attachPlayerEvents(): void {
    this.#player.on('start', () => {
      // Authoritative confirmation from Lavalink — covers any path where
      // playback began without `#playTrack` having set the flag.
      this.#playing = true;
      this.#autoplayRetries = 0;
      this.#trackStartedAt = Date.now();
      this.#clearIdleTimer();
      this.#emit('TRACK_START');
      const track = this.queue.current;
      if (track === null) return;

      // The other half of the pair the TRACK_END line completes. Together they
      // answer "what was playing, where did its audio come from, and how much
      // of it actually arrived" without needing to correlate across services.
      this.#logger.debug(
        {
          event: 'TRACK_START',
          title: track.title,
          author: track.author,
          identifier: track.identifier,
          source: track.source,
          playbackSource: track.playbackSource ?? track.source,
          uri: track.uri,
          expectedMs: track.durationMs,
          startedAt: new Date(this.#trackStartedAt).toISOString(),
        },
        'Track started',
      );

      // Links are decoration: resolve them alongside the announcement rather
      // than in front of it, so a slow third party never delays the embed.
      this.#currentLinks = NO_PLATFORM_LINKS;
      void this.#refreshLinks(track);
      if (this.#announce) void this.#announceNowPlaying(track);

      // Start choosing what comes after this while it is still playing.
      // Generating a recommendation takes a candidate sweep and a search, so
      // doing it only once the queue drains is heard as a gap of silence.
      // Fire-and-forget by construction — nothing here is awaited.
      this.#onTrackStarted?.(this.guildId, track);

      // Keep the queue topped up while this track plays. This is the
      // low-water refill: autoplay adds music while there is still music,
      // so the drain path below is the exception rather than the routine.
      this.#maintainAutoplay();
    });

    this.#player.on('end', (event) => {
      void this.#handleTrackEnd(event.reason, event.track.encoded);
    });

    this.#player.on('exception', (event) => {
      const track = this.queue.current;
      // The chat message stays one line, but the log keeps everything needed to
      // tell apart the failure modes that all look identical to a listener: a
      // stale youtube-source signature extractor, YouTube demanding a login for
      // one video, a genuinely unavailable track. `cause` is where Lavalink puts
      // the real root cause — it is the difference between "playback broke" and
      // "AllClientsFailedException: Must find sig function from script".
      this.#logger.warn(
        {
          title: track?.title,
          identifier: track?.identifier,
          source: track?.source,
          uri: track?.uri,
          exceptionType: exceptionTypeOf(event.exception.cause),
          exceptionMessage: event.exception.message,
          severity: event.exception.severity,
          cause: truncate(event.exception.cause, CAUSE_LOG_LIMIT),
          node: this.#player.node.name,
        },
        'Track playback exception',
      );
      // Do not announce anything yet. 'end' (loadFailed) follows immediately,
      // and that is where we try another source — telling the channel the track
      // was skipped before we have tried to rescue it would be a lie half the
      // time.
      this.#failureBeforeEnd = 'exception';
    });

    this.#player.on('stuck', (event) => {
      const track = this.queue.current;
      this.#logger.warn(
        {
          thresholdMs: event.thresholdMs,
          title: track?.title,
          identifier: track?.identifier,
          playbackSource: track?.playbackSource ?? track?.source,
          uri: track?.uri,
        },
        'Track stuck: the source stopped delivering audio',
      );
      // Stopping produces an 'end' with reason 'stopped', which is otherwise
      // indistinguishable from a user pressing skip. Flagging it here is what
      // lets the end handler treat it as the source failure it is and try
      // another provider, rather than silently moving to the next song.
      this.#failureBeforeEnd = 'stuck';
      void this.#player.stopTrack();
    });

    this.#player.on('closed', (event) => {
      this.#logger.warn({ code: event.code, reason: event.reason }, 'Voice websocket closed');
    });
  }

  async #handleTrackEnd(reason: string, endedEncoded?: string): Promise<void> {
    // 'replaced' means we started another track ourselves (jump, previous, a
    // source rescue): audio IS playing. `#playing` must survive untouched —
    // clearing it here left the flag false for the whole replacement track,
    // which made `/play` restart the current song and let idle timers
    // disconnect mid-music. The intent that provoked the replacement is spent.
    if (reason === 'replaced') {
      this.#advanceIntent = null;
      return;
    }

    // A track can only end once. Two `end` events for one track — a
    // duplicated gateway event, or a late one landing after the queue has
    // already advanced — used to advance the queue twice: the second arrived
    // while the next track's `playTrack` was in flight, cleared `#playing`,
    // wrote a history row for a song that never played a frame, and moved
    // on again. Lavalink names the track in every end event, and a track
    // that is no longer `current` has, by definition, already been dealt
    // with. (Not keyed on "between playTrack and start": a load failure
    // ends a track that never started, and must still advance the queue.)
    const current = this.queue.current;
    const stale =
      endedEncoded !== undefined && current !== null && endedEncoded !== current.encoded;
    if (stale) {
      this.#logger.debug(
        { event: 'TRACK_END_IGNORED', reason, current: current.title },
        'Ignored a track end for a track that is not the one playing',
      );
      return;
    }

    this.#endInFlight = true;
    try {
      await this.#processTrackEnd(reason, current);
    } finally {
      this.#endInFlight = false;
    }
  }

  async #processTrackEnd(reason: string, finished: QueuedTrack | null): Promise<void> {
    // The track is genuinely over; `#playTrack` re-sets this when recovery or
    // the next track starts.
    this.#playing = false;

    const failureBefore = this.#failureBeforeEnd;
    this.#failureBeforeEnd = null;

    // How much audio actually reached the listener.
    //
    // Two clocks, and the larger wins, because each is wrong in a different
    // direction and never both at once. Lavalink's `position` is authoritative
    // after a seek but only refreshes on the player-update interval, so it
    // still reads zero for a track that died in its first seconds. Wall-clock
    // covers exactly that gap, but overstates playback across a pause. Taking
    // the maximum means a pause or a seek can only ever make a track look MORE
    // complete — the safe direction, since the consequence of being wrong here
    // is calling a real completion a failure.
    const elapsedMs = this.#trackStartedAt > 0 ? Date.now() - this.#trackStartedAt : 0;
    const reachedMs = Math.max(elapsedMs, this.#player.position);
    const expectedMs = finished?.durationMs ?? 0;
    const shortfallMs = expectedMs - reachedMs;
    const truncated = isTruncatedPlayback({
      reason,
      expectedMs,
      reachedMs,
      ...(finished === null ? {} : { isStream: finished.isStream }),
    });

    // Everything the next person debugging a bad playback needs, on one line,
    // for every end — not only the failures, because "it ended normally" is
    // itself the claim that has to be checkable.
    const failureKind = failureBefore ?? (truncated ? 'truncated' : null);
    this.#logger[failureKind === null ? 'debug' : 'warn'](
      {
        event: 'TRACK_END',
        reason,
        failure: failureKind,
        title: finished?.title,
        author: finished?.author,
        identifier: finished?.identifier,
        source: finished?.source,
        playbackSource: finished?.playbackSource ?? finished?.source,
        uri: finished?.uri,
        expectedMs,
        reachedMs,
        shortfallMs: expectedMs > 0 ? shortfallMs : undefined,
        startedAt:
          this.#trackStartedAt > 0 ? new Date(this.#trackStartedAt).toISOString() : undefined,
        endedAt: new Date().toISOString(),
        intent: this.#advanceIntent,
      },
      failureKind === null ? 'Track ended' : 'Track ended early: the source stopped delivering',
    );

    // A source that failed gets one chance to be replaced from another provider
    // before the track is written off. This runs here rather than in the
    // exception handler because 'end' arrives right behind the exception and
    // would otherwise advance the queue past the track we just rescued.
    //
    // Three shapes of failure land here, and none of them is a finished song:
    //
    //   - `loadFailed` after an exception — the source refused outright;
    //   - `stopped` after a stuck event — the source went silent mid-stream;
    //   - `finished` far short of the runtime — the source hit end-of-file
    //     early, which Lavalink cannot distinguish from a song ending because
    //     to the decoder the two are the same thing.
    //
    // The last one is why this check exists at all. Without it a 30-second
    // preview stream, or a stream that dies after four seconds, advances the
    // queue as though the track had played through.
    const sourceFailed =
      (failureBefore === 'exception' && reason === 'loadFailed') ||
      (failureBefore === 'stuck' && reason !== 'replaced') ||
      truncated;

    if (sourceFailed && finished !== null && !this.#destroyed) {
      if (await this.#playFromAnotherSource(finished)) return;
      // Nothing playable anywhere — now the skip is real, so say so. Deferring
      // the message to here is what keeps a rescued track from being announced
      // as skipped a moment before it starts playing.
      await this.#notify(`⚠️ Playback error on **${finished.title}** — skipping.`);
    }

    const intent = this.#advanceIntent;
    this.#advanceIntent = null;

    // Record history before the cursor moves. Fire-and-forget on the normal
    // path, but the promise is kept: when the queue drains, autoplay reads
    // recent history to seed and exclude, and the single most likely track to
    // be re-recommended is the one that JUST finished — racing this write
    // meant it was routinely missing from both.
    let historyWrite: Promise<unknown> = Promise.resolve();
    if (
      finished !== null &&
      (reason === 'finished' || reason === 'stopped' || reason === 'loadFailed')
    ) {
      // The measured figure, not the wall clock: a track the source cut short
      // must not be recorded as a full play, or the taste model reads a failed
      // stream as an endorsement.
      const playedMs = reachedMs;
      // Only an actual /skip is a rejection; /jump and /previous also stop the
      // track but are navigation, and labelling them skips taught the taste
      // model to avoid whatever song the listener happened to jump away from.
      const rejected = reason === 'stopped' && intent === 'skip';
      historyWrite = this.#store
        .recordHistory(this.guildId, finished, { playedMs, skipped: rejected })
        .catch(() => undefined);
      this.#onTrackFinished?.(this.guildId, finished, { skipped: rejected, playedMs });
    }

    if (this.#destroyed) return;

    // A user skip must not honour `track` loop, or /skip would replay it.
    const next = intent !== null ? this.queue.skip() : this.queue.advance();

    if (next === null) {
      this.#persist();
      this.#emit('TRACK_END');

      // An explicit stop means stop. Autoplay only continues a session that
      // ran out on its own.
      const stopped = this.#stopRequested;
      this.#stopRequested = false;
      if (stopped) {
        this.#startIdleTimer();
        return;
      }

      // The just-finished track should be visible to autoplay's history
      // reads — but not at any price: a slow write must not become silence.
      await Promise.race([historyWrite, delay(HISTORY_WAIT_MS)]);
      const outcome = await this.#tryAutoplay();
      if (outcome === 'continued') return;
      // 'failed' already told the channel and scheduled its retry; only a
      // genuine exhaustion is the end of the queue.
      if (outcome === 'exhausted') {
        await this.#notify('✅ Queue finished. Add more with `/play`.');
      }
      this.#startIdleTimer();
      return;
    }

    await this.#playTrack(next);
    this.#persist();
  }

  /**
   * How many tracks a refill should ask for right now: enough to reach the
   * target, never more. Zero when the queue is above the low-water mark.
   */
  #autoplayShortfall(): number {
    const upcoming = this.queue.upcoming.length;
    if (upcoming > this.#autoplayLowWaterMark) return 0;
    return Math.max(0, this.#autoplayTargetQueueSize - upcoming);
  }

  /**
   * Low-water refill: top the queue up in the background while music plays.
   *
   * Fire-and-forget by design — the caller is a player event handler or a
   * queue mutation and must not wait on candidate generation. One refill at
   * a time per player (`#autoplayActive` is shared with the drain path, so
   * a low-water refill and a drain-time request can never run together and
   * double-fill the queue). Loops while still short, because one request may
   * return fewer than asked; stops the moment a request returns nothing, so
   * an empty pool is one failed request, not a hot loop.
   */
  #maintainAutoplay(): void {
    if (!this.#autoplayEnabled || this.#autoplayInFlight !== null || this.#destroyed) return;
    if (!this.isPlaying) return;
    const need = this.#autoplayShortfall();
    if (need === 0) return;

    const run = (async () => {
      try {
        let shortfall = need;
        while (shortfall > 0 && this.#autoplayEnabled && !this.#destroyed) {
          const before = this.queue.upcoming.length;
          const picks = await this.#requestAutoplay(shortfall);
          if (picks.length === 0) break;
          await this.enqueue(picks);
          this.#logger.info(
            {
              event: 'QUEUE_REFILL',
              trigger: 'low-water',
              queueBefore: before,
              queueAfter: this.queue.upcoming.length,
              generated: picks.length,
              lowWaterMark: this.#autoplayLowWaterMark,
              target: this.#autoplayTargetQueueSize,
            },
            'Autoplay refilled the queue',
          );
          shortfall = Math.max(0, this.#autoplayTargetQueueSize - this.queue.upcoming.length);
        }
      } catch (error) {
        // A failed top-up is not a stopped radio: the drain path still runs
        // when the queue actually empties, with its own retry.
        this.#logger.warn({ err: error }, 'Low-water autoplay refill failed');
      } finally {
        this.#autoplayInFlight = null;
      }
    })();
    this.#autoplayInFlight = run;
  }

  /** One refill request, with a deadline. */
  async #requestAutoplay(count: number): Promise<readonly QueuedTrack[]> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`Autoplay request timed out after ${String(AUTOPLAY_REQUEST_TIMEOUT_MS)}ms`),
        );
      }, AUTOPLAY_REQUEST_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([this.#onAutoplayRequest(this.guildId, count), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Continue when the queue has drained.
   *
   * This is the exception path now — the low-water refill normally keeps
   * the queue from ever reaching here — and it is the last line before
   * "queue finished". Three outcomes, because they mean different things to
   * the listener: `continued` (music is playing), `exhausted` (the planner,
   * after relaxing its rules, has nothing — the honest end of the queue),
   * `failed` (the request threw or timed out — a retry is scheduled and the
   * channel has been told; not the end of the queue).
   */
  async #tryAutoplay(): Promise<'continued' | 'exhausted' | 'failed'> {
    if (!this.#autoplayEnabled) return 'exhausted';

    // A refill already on its way is not an empty pool. Wait for it; if it
    // got the music going there is nothing left to do here.
    const inFlight = this.#autoplayInFlight;
    if (inFlight !== null) {
      await inFlight.catch(() => undefined);
      if (this.isPlaying) return 'continued';
      if (await this.#startParked()) return 'continued';
    }

    const before = this.queue.upcoming.length;
    let settle: (() => void) | undefined;
    this.#autoplayInFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      const picks = await this.#requestAutoplay(this.#autoplayTargetQueueSize);
      if (picks.length === 0) {
        // A refill may have landed while this request ran (or during the
        // history wait before it); a full queue is never "exhausted".
        if (await this.#startParked()) return 'continued';
        this.#logger.warn(
          { event: 'AUTOPLAY_EXHAUSTED', queueBefore: before },
          'Autoplay produced no playable candidate after fallback; queue will end',
        );
        return 'exhausted';
      }

      // `enqueue` will not auto-start while the end handler is in flight
      // (this is usually called from inside it), so the drain path starts
      // the parked cursor itself.
      const { startedPlayback: autoStarted } = await this.enqueue(picks);
      const startedPlayback = autoStarted || (await this.#startParked());
      this.#logger.info(
        {
          event: 'QUEUE_REFILL',
          trigger: 'drain',
          queueBefore: before,
          queueAfter: this.queue.upcoming.length,
          generated: picks.length,
        },
        'Autoplay refilled a drained queue',
      );
      if (startedPlayback && this.#announce) {
        await this.#notify(
          `📻 Autoplay: queue finished, continuing with **${picks[0]?.title ?? 'similar tracks'}**. Disable with \`/autoplay\`.`,
        );
      }
      return startedPlayback ? 'continued' : 'exhausted';
    } catch (error) {
      // Technical detail stays in the log; the listener gets an explanation
      // and reassurance, not an exception name. Exactly one retry, a few
      // seconds out: a transient provider or database hiccup must not end
      // the radio, and a persistent outage must not spam the channel.
      this.#autoplayRetries += 1;
      if (this.#autoplayRetries === 1) {
        this.#logger.warn({ err: error }, 'Autoplay failed; retrying once shortly');
        this.#scheduleAutoplayRetry();
        await this.#notify(
          "⚠️ I couldn't prepare the next songs right now. I'll try again in a moment — you can also add songs with `/play`.",
        );
        return 'failed';
      }
      this.#logger.warn({ err: error }, 'Autoplay failed again; giving up until the next track');
      return 'exhausted';
    } finally {
      this.#autoplayInFlight = null;
      settle?.();
    }
  }

  /**
   * Start playback from a parked cursor. After a drain the cursor sits at
   * the old length — exactly where new tracks land, so `current` is already
   * the first of them; on a fresh queue `advance()` moves onto it.
   */
  async #startParked(): Promise<boolean> {
    if (this.isPlaying) return true;
    const first = this.queue.current ?? this.queue.advance();
    if (first === null) return false;
    await this.#playTrack(first);
    return true;
  }

  #scheduleAutoplayRetry(): void {
    if (this.#autoplayRetryTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.#autoplayRetryTimer = undefined;
      // Only if nothing else got the music going in the meantime.
      if (this.#destroyed || this.isPlaying || !this.#autoplayEnabled) return;
      void this.#tryAutoplay().then(async (outcome) => {
        if (outcome === 'continued') {
          this.#clearIdleTimer();
          return;
        }
        await this.#notify('✅ Queue finished. Add more with `/play`.');
      });
    }, AUTOPLAY_RETRY_DELAY_MS);
    timer.unref();
    this.#autoplayRetryTimer = timer;
  }

  /**
   * Re-source `failed` and play the replacement in its place.
   *
   * @returns True when playback continued with an alternative; false when the
   *   caller should fall through to its normal skip handling.
   */
  async #playFromAnotherSource(failed: QueuedTrack): Promise<boolean> {
    if (this.#onFindAlternative === undefined) return false;
    if (this.#reSourced.has(failed.identifier)) return false;
    this.#reSourced.add(failed.identifier);

    let alternative: QueuedTrack | null = null;
    try {
      alternative = await this.#onFindAlternative(failed, failed.source);
    } catch (error) {
      this.#logger.warn({ err: error, title: failed.title }, 'Alternative source lookup failed');
    }

    if (alternative === null || this.#destroyed) return false;
    if (!this.queue.replaceCurrent(alternative)) return false;

    this.#logger.info(
      { title: failed.title, from: failed.source, to: alternative.source },
      'Recovered track from another source',
    );
    await this.#playTrack(alternative);
    this.#persist();
    return true;
  }

  /** Resolve and store the "listen on" links for `track`. */
  async #refreshLinks(track: QueuedTrack): Promise<void> {
    if (this.#onResolveLinks === undefined) return;
    try {
      const links = await this.#onResolveLinks(track);
      // Guard against a slow lookup landing after the next track started.
      if (this.queue.current?.identifier === track.identifier) this.#currentLinks = links;
    } catch (error) {
      this.#logger.debug({ err: error, title: track.title }, 'Platform link lookup failed');
    }
  }

  /** Cross-platform links for the playing track; empty until they resolve. */
  get currentLinks(): PlatformLinks {
    return this.#currentLinks;
  }

  async #playTrack(track: QueuedTrack): Promise<void> {
    try {
      this.#playing = true;
      await this.#player.playTrack({
        track: { encoded: track.encoded },
        volume: this.#volume,
      });
    } catch (error) {
      this.#playing = false;
      this.#logger.error({ err: error, track: track.identifier }, 'playTrack failed');
      await this.#notify(`⚠️ Could not play **${track.title}** — skipping.`);
      const next = this.queue.skip();
      if (next !== null) {
        await this.#playTrack(next);
      } else if ((await this.#tryAutoplay()) !== 'continued') {
        // The last track in the queue was unplayable: that is a drained
        // queue, and autoplay gets its say before the player parks.
        this.#startIdleTimer();
      }
    }
  }

  /* ------------------------------------------------------------------- misc */

  async #announceNowPlaying(track: QueuedTrack): Promise<void> {
    // The links are being fetched concurrently by `#refreshLinks`; give them a
    // moment to land so the announcement carries them, but never hold the
    // message hostage to a third party that is not answering.
    const links = await this.#awaitLinks(track);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Now playing' })
      .setDescription(`${trackLink(track)} — ${track.author}`)
      .addFields(
        { name: 'Duration', value: formatTrackDuration(track), inline: true },
        { name: 'Requested by', value: track.requestedByName, inline: true },
      );

    const rendered = renderPlatformLinks(links);
    if (rendered !== null) embed.addFields({ name: 'Listen on', value: rendered });
    if (track.artworkUrl !== null) embed.setThumbnail(track.artworkUrl);

    await this.#notify({ embeds: [embed] });
  }

  /** Poll briefly for the in-flight link lookup, then give up on it. */
  async #awaitLinks(track: QueuedTrack): Promise<PlatformLinks> {
    const deadline = Date.now() + LINK_WAIT_MS;
    while (Date.now() < deadline) {
      if (hasAnyLink(this.#currentLinks)) return this.#currentLinks;
      if (this.queue.current?.identifier !== track.identifier) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return this.#currentLinks;
  }

  /** Send to the bound text channel; failures are logged, never thrown. */
  async #notify(payload: string | { embeds: EmbedBuilder[] }): Promise<void> {
    try {
      const channel = await this.#client.channels.fetch(this.#textChannelId);
      if (channel?.isSendable() === true) {
        await channel.send(payload);
      }
    } catch (error) {
      this.#logger.debug({ err: error }, 'Channel notification failed');
    }
  }

  /** Full state snapshot for realtime consumers. */
  snapshot(): PlayerSnapshot {
    const toView = (track: QueuedTrack) => ({
      identifier: track.identifier,
      title: track.title,
      author: track.author,
      durationMs: track.durationMs,
      uri: track.uri,
      artworkUrl: track.artworkUrl,
      isStream: track.isStream,
      source: track.source,
      requestedByName: track.requestedByName,
      // The canonical identity, so a dashboard "not like" names the same song
      // the bot would, whichever provider streamed it.
      trackKey: track.sourceKey ?? identityOf(track.author, track.title).key,
    });
    const upcoming = this.queue.upcoming;

    return {
      current: this.queue.current === null ? null : toView(this.queue.current),
      positionMs: Math.max(0, Math.round(this.positionMs)),
      paused: this.paused,
      volume: this.#volume,
      loopMode: this.queue.loopMode,
      autoplayEnabled: this.#autoplayEnabled,
      stayConnected: this.#stayConnected,
      activeFilter: this.#activeFilter,
      voiceChannelId: this.#voiceChannelId,
      listenerId: this.#listenerId,
      upcoming: upcoming.slice(0, 100).map(toView),
      upcomingTotal: upcoming.length,
    };
  }

  #emit(type: PlayerEventType): void {
    try {
      this.#onEvent?.(type, this.#destroyed ? null : this.snapshot());
    } catch (error) {
      this.#logger.debug({ err: error, type }, 'Player event sink failed');
    }
  }

  #persist(): void {
    this.#store.scheduleSave(this.guildId, this.queue, {
      volume: this.#volume,
      paused: this.paused,
      voiceChannelId: this.#voiceChannelId,
      textChannelId: this.#textChannelId,
      listenerId: this.#listenerId,
    });
  }

  #startIdleTimer(): void {
    // 24/7 mode: the whole point is to stay in the channel while idle.
    if (this.#stayConnected) return;

    this.#clearIdleTimer();
    const timer = setTimeout(() => {
      void this.#onSelfDestruct(this.guildId, 'idle-timeout');
    }, this.#idleTimeoutSeconds * 1000);
    timer.unref();
    this.#idleTimer = timer;
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }
}

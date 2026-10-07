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

import { delay } from '../lib/delay.js';
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

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}… (truncated)`;
}

/**
 * The play token Lavalink echoed back, when it echoed one.
 *
 * Lavalink v4 stores arbitrary `userData` next to a track and returns it on
 * every event for that track, untouched. That makes it the one exact answer
 * to "which play is this the end of" — immune to the same song being queued
 * twice in a row or looped, where the track's own identifier cannot tell two
 * plays apart.
 *
 * Read defensively on purpose: shoukaku's `Track` type does not declare the
 * field, and a node that does not send it is not an error — the caller falls
 * back to comparing identifiers, which is correct for every case except
 * back-to-back copies of one song.
 */
function playTokenOf(track: unknown): number | undefined {
  const value = (track as { readonly userData?: { readonly playSeq?: unknown } } | null)?.userData
    ?.playSeq;
  return typeof value === 'number' ? value : undefined;
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
  /**
   * Called when Discord closes the voice websocket, with the code it sent.
   * The player does not judge the code — reconnecting means rebuilding this
   * object, which only the manager can do. Must return immediately.
   */
  readonly onVoiceClosed?: (guildId: string, code: number, reason: string) => void;
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
  /** Callers waiting to hear when the next track actually starts. */
  readonly #trackStartWaiters = new Set<(startedAt: number) => void>();

  /**
   * Whether anybody who is not a bot is in the voice channel.
   *
   * Music is for people in a room. 24/7 mode keeps the CONNECTION alive, not
   * the playback: a bot left alone used to keep pulling autoplay picks and
   * playing them to nobody — inaudible to everyone, and still spending
   * Lavalink time, recommendation budget and (worst of all) writing plays into
   * the guild's listening history that nobody actually heard.
   *
   * Defaults to true so a player whose occupancy has never been reported
   * behaves exactly as it always did; the music layer sets it at creation and
   * the voice-state event keeps it current.
   */
  #listenersPresent = true;
  /**
   * When the room last emptied, or null while somebody is in it.
   *
   * The router reclaims idle players for other channels, and "empty right now"
   * is too eager a test: a channel is momentarily empty in the middle of a mass
   * move. This is what lets a reclaim wait for the room to have been empty for
   * a while rather than for an instant.
   */
  #emptySince: number | null = null;

  /**
   * Set only when THIS class paused because the room emptied, so an arriving
   * listener resumes what the bot paused without ever overriding a pause a
   * person asked for.
   */
  #pausedForEmptyRoom = false;

  /**
   * A queue that is loaded but that nobody has asked to hear.
   *
   * Set when the 24/7 restore reloads a channel's saved queue at startup.
   * 24/7 means the bot waits in the channel; it does not mean it performs to
   * whoever happens to walk in. Without this, restarting a container while
   * somebody was sitting in the channel made the bot appear and immediately
   * start playing a queue from a previous session — and if that queue had
   * finished, autoplay invented new tracks for them.
   *
   * Distinct from {@link #pausedForEmptyRoom}, which marks music a person
   * *did* start and the bot paused on their behalf. That still resumes on its
   * own, because continuing is what was asked for.
   */
  #awaitingRequest = false;
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
  /**
   * Monotonic id of the current play, bumped by every `#playTrack` and sent
   * to Lavalink as the track's `userData`.
   *
   * This is the correlation handle for end events, and it exists because
   * nothing Lavalink reports about a track identifies the PLAY. The `encoded`
   * blob is not even a stable identity for the track: Lavalink re-encodes the
   * live `AudioTrack` for every event, and the last eight bytes of the
   * encoding are the playback POSITION, so the string that comes back when a
   * song ends never equals the string handed over when it started. The
   * identifier is stable but names the song, not the play, so it cannot tell
   * two plays of one song apart. The token can.
   */
  #playSeq = 0;
  /**
   * The play whose end has already been processed. Starts equal to `#playSeq`
   * so an end for a play this process never started — a resumed Lavalink
   * session replaying its last event — is ignored rather than advancing a
   * queue that is about to be restored anyway.
   */
  #endedPlaySeq = 0;
  /**
   * Whether the "this node does not echo play tokens" warning has been said.
   * The condition is a property of the Lavalink build, not of one track, so
   * it is worth saying once and never again.
   */
  #warnedNoPlayToken = false;
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
  readonly #onVoiceClosed: ((guildId: string, code: number, reason: string) => void) | undefined;
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
    this.#onVoiceClosed = options.onVoiceClosed;
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

  /** Where this player announces. Needed to rebuild it on a voice reconnect. */
  get textChannelId(): string {
    return this.#textChannelId;
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

  /** Whether a non-bot member is currently in the bot's voice channel. */
  get hasListeners(): boolean {
    return this.#listenersPresent;
  }

  /** Epoch ms since the room emptied, or null while it has listeners. */
  get emptySince(): number | null {
    return this.#emptySince;
  }

  get stayConnected(): boolean {
    return this.#stayConnected;
  }

  /** 24/7 mode. Enabling cancels any pending idle disconnect immediately. */
  setStayConnected(enabled: boolean): void {
    this.#stayConnected = enabled;
    this.#syncIdleTimer();
    this.#emit('STAY_CONNECTED_CHANGE');
  }

  /**
   * How long nothing may play before the bot leaves. A changed setting reaches
   * a room that is already idle, counted afresh from now — otherwise it would
   * only apply to the next channel the bot joins.
   */
  setIdleTimeout(seconds: number): void {
    this.#idleTimeoutSeconds = seconds;
    this.#clearIdleTimer();
    this.#syncIdleTimer();
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
  /**
   * Mark a restored queue as loaded but unasked-for.
   *
   * Called by the 24/7 restore. Cleared by the first deliberate request.
   */
  armRestoredQueue(): void {
    this.#awaitingRequest = true;
  }

  async resumeAutoplay(): Promise<boolean> {
    if (this.isPlaying) return true;
    // An empty room gets no radio. Whoever walks in starts it.
    if (!this.#listenersPresent) return false;
    const outcome = await this.#tryAutoplay();
    this.#syncIdleTimer();
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
      void this.#tryAutoplay().then(() => {
        this.#syncIdleTimer();
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

  /**
   * When Lavalink next reports a track starting, as epoch ms — or undefined if
   * nothing starts within `timeoutMs`.
   *
   * Measurement only. The request to play returns when Lavalink has accepted
   * it, not when audio is flowing; the gap between the two is the stream load
   * and the voice handshake, and it is invisible without this.
   */
  whenTrackStarts(timeoutMs: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      const waiter = {
        timer: undefined as NodeJS.Timeout | undefined,
        started: (startedAt: number): void => {
          clearTimeout(waiter.timer);
          resolve(startedAt);
        },
      };
      waiter.timer = setTimeout(() => {
        this.#trackStartWaiters.delete(waiter.started);
        resolve(undefined);
      }, timeoutMs);
      waiter.timer.unref();
      this.#trackStartWaiters.add(waiter.started);
    });
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
    // An explicit pause takes ownership of the paused state: the empty-room
    // resume must not later "undo" a pause somebody asked for.
    this.#pausedForEmptyRoom = false;
    await this.#player.setPaused(true);
    this.#persist();
    // A pause is nothing playing. Forgotten, it would hold the bot forever.
    this.#syncIdleTimer();
    this.#emit('TRACK_PAUSE');
  }

  async resume(): Promise<void> {
    this.#pausedForEmptyRoom = false;
    await this.#player.setPaused(false);
    this.#persist();
    this.#syncIdleTimer();
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
    // A stop on a playing track is finished by its end event, which clears
    // `#playing` and syncs again; this covers a stop with nothing playing.
    this.#syncIdleTimer();
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

  /**
   * Voice-state hook: the bot is alone (or not) in its channel.
   *
   * Playback follows the room: an empty room is paused, and 24/7 does not
   * exempt it, because an empty room hears nothing either way. Leaving does
   * not follow the room directly — it follows whether anything is playing, and
   * an emptied room gets there through that pause.
   *
   * Called on every voice-state change in the guild — a mute, a move in some
   * other channel, another bot arriving — so the transition is what matters:
   * repeating "still empty" must not re-pause, re-announce, or restart the
   * countdown to leaving.
   */
  onOccupancyChange(listenersPresent: boolean): void {
    // Makes sure a countdown exists when nothing is playing. Never restarts or
    // cancels one — see `#syncIdleTimer` for why that is the whole fix.
    this.#syncIdleTimer();

    if (this.#listenersPresent === listenersPresent) return;
    this.#listenersPresent = listenersPresent;
    this.#emptySince = listenersPresent ? null : Date.now();

    void this.#applyOccupancy(listenersPresent).catch((error: unknown) => {
      this.#logger.warn({ err: error, listenersPresent }, 'Occupancy change handling failed');
    });
  }

  /**
   * Start or stop the music to match who is in the room.
   *
   * Emptied: pause what is playing and stop any autoplay work — the guards in
   * `#maintainAutoplay` / `#tryAutoplay` cover generation, this covers the
   * track already in the speakers.
   *
   * Filled: undo exactly what this class did, and nothing else. A pause a
   * person asked for stays paused; a queue that was parked while the room was
   * empty (a 24/7 restore, or a drain nobody was there for) starts now.
   */
  async #applyOccupancy(listenersPresent: boolean): Promise<void> {
    if (this.#destroyed) return;

    if (!listenersPresent) {
      if (this.#autoplayRetryTimer !== undefined) {
        clearTimeout(this.#autoplayRetryTimer);
        this.#autoplayRetryTimer = undefined;
      }
      if (!this.isPlaying || this.paused) return;
      await this.pause();
      // Set AFTER pause(), which clears it: this is the one pause that is
      // the bot's own and may be undone automatically.
      this.#pausedForEmptyRoom = true;
      this.#logger.info(
        { event: 'EMPTY_ROOM_PAUSE', guildId: this.guildId },
        'Channel is empty; playback paused until somebody joins',
      );
      await this.#notify('⏸️ Paused — nobody is in the channel. I pick up when someone joins.');
      return;
    }

    if (this.#pausedForEmptyRoom) {
      this.#pausedForEmptyRoom = false;
      await this.resume();
      return;
    }
    // Playing already, or paused by a person: not this method's business.
    if (this.isPlaying || this.paused) return;

    /**
     * A restored queue waits to be asked for.
     *
     * Somebody walking into the channel is not a request for music. They may
     * never have used the bot, and the queue may be from a session that had
     * nothing to do with them — `/play`, `/join` or the controller starts it.
     */
    if (this.#awaitingRequest) return;

    if (await this.#startParked()) {
      this.#syncIdleTimer();
      return;
    }
    if (!this.#autoplayEnabled) return;
    await this.#tryAutoplay();
    this.#syncIdleTimer();
  }

  /* ----------------------------------------------------------------- events */

  #attachPlayerEvents(): void {
    this.#player.on('start', () => {
      // Authoritative confirmation from Lavalink — covers any path where
      // playback began without `#playTrack` having set the flag.
      this.#playing = true;
      this.#autoplayRetries = 0;
      this.#trackStartedAt = Date.now();
      for (const started of this.#trackStartWaiters) started(this.#trackStartedAt);
      this.#trackStartWaiters.clear();
      this.#syncIdleTimer();
      this.#emit('TRACK_START');
      const track = this.queue.current;
      if (track === null) return;

      // The other half of the pair the TRACK_END line completes. Together they
      // answer "what was playing, where did its audio come from, and how much
      // of it actually arrived" without needing to correlate across services.
      this.#logger.info(
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
      // `info.identifier` and the echoed play token — deliberately NOT
      // `event.track.encoded`. See `#playSeq`: the encoded blob carries the
      // playback position, so it changes between the play and the end of
      // every track that actually ran.
      void this.#handleTrackEnd(
        event.reason,
        event.track.info.identifier,
        playTokenOf(event.track),
      );
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
      void this.#player.stopTrack().catch((error: unknown) => {
        this.#logger.warn({ err: error }, 'Stopping a stuck track failed');
      });
    });

    this.#player.on('closed', (event) => {
      this.#logger.warn(
        { code: event.code, reason: event.reason, byRemote: event.byRemote },
        'Voice websocket closed',
      );
      this.#onVoiceClosed?.(this.guildId, event.code, event.reason);
    });
  }

  async #handleTrackEnd(
    reason: string,
    endedIdentifier?: string,
    endedPlay?: number,
  ): Promise<void> {
    // 'replaced' means we started another track ourselves (jump, previous, a
    // source rescue): audio IS playing. `#playing` must survive untouched —
    // clearing it here left the flag false for the whole replacement track,
    // which made `/play` restart the current song and let idle timers
    // disconnect mid-music. The intent that provoked the replacement is spent.
    if (reason === 'replaced') {
      this.#advanceIntent = null;
      return;
    }

    // A track can only end once, and only the play that is current can end.
    // Two guards, because they answer different questions.
    //
    // WHICH PLAY IS THIS THE END OF?
    //
    // Preferably the node tells us: `#playTrack` attaches the play token as
    // Lavalink `userData`, and Lavalink echoes it back on every event for
    // that track. That is exact — it tells apart two plays of the SAME song
    // (a looped track, or one song queued twice), which nothing derived from
    // the track itself can do.
    //
    // Without it, fall back to the track's `identifier`. Note what that is
    // NOT: the `encoded` blob, which is what this guard used to compare.
    // Lavalink re-encodes the live track for every event and writes the
    // playback position into the encoding, so `encoded` at the end of a song
    // is never `encoded` at its start — the guard called EVERY natural end
    // stale and the session stopped dead after one track. Only `loadFailed`
    // still matched, which is why broken tracks kept advancing while working
    // ones did not.
    //
    // HAS THIS PLAY ALREADY ENDED?
    //
    // The duplicate protection: two `end` events for ONE play — a duplicated
    // gateway event, or a late one landing while the next `playTrack` is in
    // flight — used to advance the queue twice, clearing `#playing` and
    // writing a history row for a song that never played a frame.
    // Silence here is the evidence the exact correlation is live; this line
    // is what tells an operator it is not, and that back-to-back copies of one
    // song fall back to identifier matching.
    if (endedPlay === undefined && !this.#warnedNoPlayToken) {
      this.#warnedNoPlayToken = true;
      this.#logger.warn(
        { event: 'PLAY_TOKEN_MISSING', reason },
        'Lavalink did not echo the play token; correlating track ends on identifier instead',
      );
    }

    const current = this.queue.current;
    const staleCause =
      endedPlay !== undefined
        ? endedPlay === this.#playSeq
          ? null
          : 'not-current-play'
        : endedIdentifier !== undefined &&
            current !== null &&
            endedIdentifier !== current.identifier
          ? 'not-current-track'
          : null;
    if (staleCause !== null) {
      this.#logger.info(
        {
          event: 'TRACK_END_IGNORED',
          cause: staleCause,
          reason,
          ended: endedIdentifier,
          endedPlay,
          playSeq: this.#playSeq,
          current: current?.identifier,
          currentTitle: current?.title,
        },
        'Ignored a track end for a track that is not the one playing',
      );
      return;
    }
    if (this.#endedPlaySeq === this.#playSeq) {
      this.#logger.info(
        { event: 'TRACK_END_IGNORED', cause: 'duplicate', reason, playSeq: this.#playSeq },
        'Ignored a duplicate track end for a play that has already ended',
      );
      return;
    }
    this.#endedPlaySeq = this.#playSeq;

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
    this.#logger[failureKind === null ? 'info' : 'warn'](
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
        .recordHistory(this.guildId, this.#voiceChannelId, finished, {
          playedMs,
          skipped: rejected,
        })
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
        this.#syncIdleTimer();
        return;
      }

      // Nobody is in the channel. The queue has not "finished" — there is
      // simply no one to play the next song to, and generating one would put
      // a track nobody heard into this guild's listening history. Whoever
      // walks in next starts it again.
      if (!this.#listenersPresent) {
        this.#syncIdleTimer();
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
        await this.#notify(
          this.#autoplayEnabled
            ? '✅ Queue finished. Autoplay found no available tracks with a verified matching language. The song language may be unknown or matching tracks unavailable. Add another song with `/play`.'
            : '✅ Queue finished. Add more with `/play`.',
        );
      }
      this.#syncIdleTimer();
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
    if (!this.isPlaying || !this.#listenersPresent) return;
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
    // Worse than resuming a queue: these are tracks that never existed until
    // somebody walked past. `exhausted` because there is nothing to continue —
    // no request has been made yet — and it must not schedule a retry.
    if (this.#awaitingRequest) return 'exhausted';
    if (!this.#autoplayEnabled) return 'exhausted';
    // Generating a radio for nobody costs a full candidate sweep and writes
    // plays into history that no one heard. The drain path checks occupancy
    // before it gets here; this covers every other caller.
    if (!this.#listenersPresent) return 'exhausted';

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
      if (!this.#listenersPresent) return;
      void this.#tryAutoplay().then(async (outcome) => {
        this.#syncIdleTimer();
        if (outcome === 'continued') return;
        await this.#notify(
          '✅ Queue finished. Autoplay could not find an available same-language match. Add another song with `/play`.',
        );
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
    // Whatever the queue was when it was restored, it is being played now
    // because somebody asked — the paths that start music on their own are
    // gated above.
    this.#awaitingRequest = false;
    // A new play, so the end that eventually arrives is a different end from
    // the last one. Bumped before the request goes out: a `loadFailed` end
    // can arrive for a track that never produced a single frame, and it still
    // has to be processed.
    this.#playSeq += 1;
    try {
      this.#playing = true;
      this.#logger.info(
        {
          event: 'PLAYBACK_START_REQUEST',
          playSeq: this.#playSeq,
          title: track.title,
          identifier: track.identifier,
          playbackSource: track.playbackSource ?? track.source,
          upcoming: this.queue.upcoming.length,
        },
        'Handing the next track to Lavalink',
      );
      await this.#player.playTrack({
        // `userData` rides along with the track and comes back on every event
        // Lavalink sends about it, which is what makes the end of THIS play
        // distinguishable from the end of an earlier play of the same song.
        track: { encoded: track.encoded, userData: { playSeq: this.#playSeq } },
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
        this.#syncIdleTimer();
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
      this.#logger.warn(
        { err: error, channelId: this.#textChannelId },
        'Channel notification failed',
      );
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
      this.#logger.warn({ err: error, type }, 'Player event sink failed');
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

  /** In use: 24/7 is on, or a track is audibly playing. */
  #isActive(): boolean {
    return this.#stayConnected || (this.#playing && !this.paused);
  }

  /**
   * Make the countdown to leaving match whether anything is playing.
   *
   * One rule: with nothing playing, the bot leaves after the idle timeout. A
   * finished queue, a stop, a pause somebody forgot, a join nobody followed
   * with a song, a room everyone walked out of (which pauses first) — all the
   * same. 24/7 is the only exemption.
   *
   * Idempotent, and it never restarts a countdown that is already running.
   * That is the fix rather than a detail. The countdown used to be moved by
   * voice-state events, which arrive for every mute and every move anywhere in
   * the server: a listener unmuting cancelled it outright, and an empty room
   * had its five minutes reset by each event, so in practice the bot never
   * left. Now only a change in whether music plays can move it.
   */
  #syncIdleTimer(): void {
    if (this.#destroyed || this.#isActive()) {
      this.#clearIdleTimer();
      return;
    }
    if (this.#idleTimer !== undefined) return;

    const timer = setTimeout(() => {
      this.#idleTimer = undefined;
      // A path that started music without syncing must not be torn down
      // mid-song; the next idle moment starts a fresh countdown.
      if (this.#isActive()) return;
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

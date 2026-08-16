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
import { formatTrackDuration, trackLink, type QueuedTrack } from './track.js';
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
  /** Called when the player wants to be torn down (idle timeout, fatal error). */
  readonly onSelfDestruct: (guildId: string, reason: string) => Promise<void>;
  /**
   * Called when the queue drains with autoplay enabled. Returns tracks to
   * continue with (may be empty — the player then parks as usual).
   */
  readonly onAutoplayRequest: (guildId: string) => Promise<readonly QueuedTrack[]>;
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
  #skipRequested = false;
  #destroyed = false;
  #stayConnected: boolean;
  #autoplayEnabled: boolean;
  #autoplayActive = false;
  #activeFilter: FilterPresetName | 'speed' | 'pitch' | null = null;
  readonly #onAutoplayRequest: (guildId: string) => Promise<readonly QueuedTrack[]>;
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
  #recoverCurrent = false;
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

  get autoplayEnabled(): boolean {
    return this.#autoplayEnabled;
  }

  setAutoplayEnabled(enabled: boolean): void {
    this.#autoplayEnabled = enabled;
    this.#emit('AUTOPLAY_CHANGE');
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
    this.#persist();
    this.#emit('QUEUE_UPDATE');

    if (!this.isPlaying) {
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
    this.#skipRequested = true;
    // stopTrack fires the 'end' event (reason: stopped); advancement happens there.
    await this.#player.stopTrack();
    return this.queue.current;
  }

  async jumpTo(index: number): Promise<QueuedTrack | null> {
    const target = this.queue.jumpTo(index);
    if (target === null) return null;
    this.#skipRequested = true;
    await this.#playTrack(target);
    this.#persist();
    return target;
  }

  /** Go back to the previously played track. Null when at the start. */
  async previous(): Promise<QueuedTrack | null> {
    const target = this.queue.previous();
    if (target === null) return null;
    this.#skipRequested = true;
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
    }
    return removed;
  }

  clearUpcoming(): number {
    const removed = this.queue.clearUpcoming();
    if (removed > 0) {
      this.#persist();
      this.#emit('QUEUE_CLEAR');
    }
    return removed;
  }

  /** Stop playback and clear the queue, but stay connected. */
  async stop(): Promise<void> {
    this.queue.reset();
    this.#skipRequested = true;
    this.#stopRequested = true;
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
    this.#player.removeAllListeners();
    await this.#store.flush(this.guildId, this.queue, this.paused);
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
      this.#trackStartedAt = Date.now();
      this.#clearIdleTimer();
      this.#emit('TRACK_START');
      const track = this.queue.current;
      if (track === null) return;

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
    });

    this.#player.on('end', (event) => {
      void this.#handleTrackEnd(event.reason);
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
      this.#recoverCurrent = true;
    });

    this.#player.on('stuck', (event) => {
      this.#logger.warn({ thresholdMs: event.thresholdMs }, 'Track stuck; skipping');
      void this.#player.stopTrack();
    });

    this.#player.on('closed', (event) => {
      this.#logger.warn({ code: event.code, reason: event.reason }, 'Voice websocket closed');
    });
  }

  async #handleTrackEnd(reason: string): Promise<void> {
    // The track is over regardless of what happens next; `#playTrack` re-sets
    // this when recovery or the next track starts.
    this.#playing = false;
    const finished = this.queue.current;

    // A source that refused to stream gets one chance to be replaced by another
    // before the track is written off. This runs here rather than in the
    // exception handler because 'end' arrives right behind the exception and
    // would otherwise advance the queue past the track we just rescued.
    const recover = this.#recoverCurrent;
    this.#recoverCurrent = false;
    if (recover && reason === 'loadFailed' && finished !== null && !this.#destroyed) {
      if (await this.#playFromAnotherSource(finished)) return;
      // Nothing playable anywhere — now the skip is real, so say so. Deferring
      // the message to here is what keeps a rescued track from being announced
      // as skipped a moment before it starts playing.
      await this.#notify(`⚠️ Playback error on **${finished.title}** — skipping.`);
    }

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
      const playedMs = this.#trackStartedAt > 0 ? Date.now() - this.#trackStartedAt : 0;
      historyWrite = this.#store
        .recordHistory(this.guildId, finished, {
          playedMs,
          skipped: reason === 'stopped',
        })
        .catch(() => undefined);
      this.#onTrackFinished?.(this.guildId, finished, {
        skipped: reason === 'stopped' && this.#skipRequested,
        playedMs,
      });
    }

    // 'replaced' means we started another track ourselves; nothing to advance.
    if (reason === 'replaced') return;
    if (this.#destroyed) return;

    const wasSkip = this.#skipRequested;
    this.#skipRequested = false;

    // A user skip must not honour `track` loop, or /skip would replay it.
    const next = wasSkip ? this.queue.skip() : this.queue.advance();

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

      // The just-finished track must be visible to autoplay's history reads.
      await historyWrite;
      if (await this.#tryAutoplay()) return;
      await this.#notify('✅ Queue finished. Add more with `/play`.');
      this.#startIdleTimer();
      return;
    }

    await this.#playTrack(next);
    this.#persist();
  }

  /** Continue with similar tracks when the queue drains. True if it did. */
  async #tryAutoplay(): Promise<boolean> {
    if (!this.#autoplayEnabled || this.#autoplayActive) return false;

    this.#autoplayActive = true;
    try {
      const picks = await this.#onAutoplayRequest(this.guildId);
      if (picks.length === 0) return false;

      const { startedPlayback } = await this.enqueue(picks);
      if (startedPlayback && this.#announce) {
        await this.#notify(
          `📻 Autoplay: queue finished, continuing with **${picks[0]?.title ?? 'similar tracks'}**. Disable with \`/autoplay\`.`,
        );
      }
      return startedPlayback;
    } catch (error) {
      // Technical detail stays in the log; the listener gets an explanation
      // and reassurance, not an exception name.
      this.#logger.warn({ err: error }, 'Autoplay failed; parking the player');
      await this.#notify(
        "⚠️ I couldn't prepare the next songs right now. I'll try again when the queue runs low — you can also add songs with `/play`.",
      );
      return false;
    } finally {
      this.#autoplayActive = false;
    }
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
      } else {
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

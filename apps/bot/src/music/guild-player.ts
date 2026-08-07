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
  type PlayerEventType,
  type PlayerSnapshot,
} from '@discord-music/shared';
import { EmbedBuilder, type Client } from 'discord.js';
import type { FilterOptions, Player } from 'shoukaku';

import { getLogger, type Logger } from '../lib/logger.js';
import type { FilterPresetName } from './filters.js';
import type { QueueStore } from './queue-store.js';
import { formatTrackDuration, trackLink, type QueuedTrack } from './track.js';
import { TrackQueue } from './track-queue.js';

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
  #skipRequested = false;
  #destroyed = false;
  #stayConnected: boolean;
  #autoplayEnabled: boolean;
  #autoplayActive = false;
  #activeFilter: FilterPresetName | 'speed' | 'pitch' | null = null;
  readonly #onAutoplayRequest: (guildId: string) => Promise<readonly QueuedTrack[]>;
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
    return this.#player.track !== null;
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
      const first = this.queue.advance() ?? this.queue.jumpTo(position);
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
    await this.#player.stopTrack();
    this.#persist();
    this.#startIdleTimer();
    this.#emit('QUEUE_CLEAR');
  }

  /** Full teardown. Called by the manager on disconnect. */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
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
      if (track !== null && this.#announce) {
        void this.#announceNowPlaying(track);
      }
    });

    this.#player.on('end', (event) => {
      void this.#handleTrackEnd(event.reason);
    });

    this.#player.on('exception', (event) => {
      this.#logger.warn({ exception: event.exception }, 'Track raised an exception');
      void this.#notify(
        `⚠️ Playback error on **${this.queue.current?.title ?? 'the current track'}** — skipping.`,
      );
      // 'end' (loadFailed) follows; advancement handled there.
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
    const finished = this.queue.current;

    // Record history before the cursor moves.
    if (
      finished !== null &&
      (reason === 'finished' || reason === 'stopped' || reason === 'loadFailed')
    ) {
      void this.#store.recordHistory(this.guildId, finished, {
        playedMs: this.#trackStartedAt > 0 ? Date.now() - this.#trackStartedAt : 0,
        skipped: reason === 'stopped',
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
      this.#logger.warn({ err: error }, 'Autoplay failed; parking the player');
      return false;
    } finally {
      this.#autoplayActive = false;
    }
  }

  async #playTrack(track: QueuedTrack): Promise<void> {
    try {
      await this.#player.playTrack({
        track: { encoded: track.encoded },
        volume: this.#volume,
      });
    } catch (error) {
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
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Now playing' })
      .setDescription(`${trackLink(track)} — ${track.author}`)
      .addFields(
        { name: 'Duration', value: formatTrackDuration(track), inline: true },
        { name: 'Requested by', value: track.requestedByName, inline: true },
      );
    if (track.artworkUrl !== null) embed.setThumbnail(track.artworkUrl);

    await this.#notify({ embeds: [embed] });
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

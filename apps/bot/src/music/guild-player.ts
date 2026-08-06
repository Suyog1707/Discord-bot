/**
 * Per-guild playback controller.
 *
 * Owns one Shoukaku `Player` plus its `TrackQueue`, translates player events
 * into queue transitions, announces tracks, records history, persists the
 * queue, and manages the idle timer that leaves empty channels.
 */
import { LIMITS, type LoopMode } from '@discord-music/shared';
import { EmbedBuilder, type Client } from 'discord.js';
import type { Player } from 'shoukaku';

import { getLogger, type Logger } from '../lib/logger.js';
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
  /** Called when the player wants to be torn down (idle timeout, fatal error). */
  readonly onSelfDestruct: (guildId: string, reason: string) => Promise<void>;
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
    this.#onSelfDestruct = options.onSelfDestruct;
    this.#logger = getLogger('guild-player').child({ guildId: options.guildId });

    this.#attachPlayerEvents();
  }

  /* ---------------------------------------------------------------- getters */

  get voiceChannelId(): string {
    return this.#voiceChannelId;
  }

  set voiceChannelId(channelId: string) {
    this.#voiceChannelId = channelId;
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

  /* ---------------------------------------------------------------- control */

  /** Add tracks and start playback if nothing is playing. */
  async enqueue(
    tracks: readonly QueuedTrack[],
    options: { readonly next?: boolean } = {},
  ): Promise<{ position: number; startedPlayback: boolean }> {
    const position = this.queue.add(tracks, options);
    this.#persist();

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

  async pause(): Promise<void> {
    await this.#player.setPaused(true);
    this.#persist();
  }

  async resume(): Promise<void> {
    await this.#player.setPaused(false);
    this.#persist();
  }

  async setVolume(volume: number): Promise<void> {
    this.#volume = volume;
    await this.#player.setGlobalVolume(volume);
    this.#persist();
  }

  async seekTo(positionMs: number): Promise<void> {
    await this.#player.seekTo(positionMs);
  }

  setLoopMode(mode: LoopMode): void {
    this.queue.loopMode = mode;
    this.#persist();
  }

  shuffle(): void {
    this.queue.shuffle();
    this.#persist();
  }

  removeUpcoming(upcomingIndex: number): QueuedTrack | null {
    const removed = this.queue.removeUpcoming(upcomingIndex);
    if (removed !== null) this.#persist();
    return removed;
  }

  clearUpcoming(): number {
    const removed = this.queue.clearUpcoming();
    if (removed > 0) this.#persist();
    return removed;
  }

  /** Stop playback and clear the queue, but stay connected. */
  async stop(): Promise<void> {
    this.queue.reset();
    this.#skipRequested = true;
    await this.#player.stopTrack();
    this.#persist();
    this.#startIdleTimer();
  }

  /** Full teardown. Called by the manager on disconnect. */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

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
      await this.#notify('✅ Queue finished. Add more with `/play`.');
      this.#startIdleTimer();
      return;
    }

    await this.#playTrack(next);
    this.#persist();
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

  #persist(): void {
    this.#store.scheduleSave(this.guildId, this.queue, {
      volume: this.#volume,
      paused: this.paused,
      voiceChannelId: this.#voiceChannelId,
      textChannelId: this.#textChannelId,
    });
  }

  #startIdleTimer(): void {
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

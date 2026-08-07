/**
 * Queue persistence + song history.
 *
 * Write-through with debounce: every mutation schedules a save; rapid
 * mutations (queueing a playlist) collapse into one write. The DB copy powers
 * the dashboard's queue view and survives restarts; the in-memory TrackQueue
 * remains the source of truth while the bot is live.
 */
import {
  MusicSource as DbMusicSource,
  LoopMode as DbLoopMode,
  type PrismaClient,
} from '@discord-music/database';
import type { LoopMode, MusicSource } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from './track.js';
import type { TrackQueue } from './track-queue.js';

const logger = getLogger('queue-store');

const SAVE_DEBOUNCE_MS = 1_500;

const TO_DB_SOURCE: Record<MusicSource, DbMusicSource> = {
  youtube: DbMusicSource.YOUTUBE,
  spotify: DbMusicSource.SPOTIFY,
  soundcloud: DbMusicSource.SOUNDCLOUD,
  deezer: DbMusicSource.DEEZER,
};

const TO_DB_LOOP: Record<LoopMode, DbLoopMode> = {
  off: DbLoopMode.OFF,
  track: DbLoopMode.TRACK,
  queue: DbLoopMode.QUEUE,
};

const FROM_DB_SOURCE: Record<DbMusicSource, MusicSource> = {
  [DbMusicSource.YOUTUBE]: 'youtube',
  [DbMusicSource.SPOTIFY]: 'spotify',
  [DbMusicSource.SOUNDCLOUD]: 'soundcloud',
  [DbMusicSource.DEEZER]: 'deezer',
};

const FROM_DB_LOOP: Record<DbLoopMode, LoopMode> = {
  [DbLoopMode.OFF]: 'off',
  [DbLoopMode.TRACK]: 'track',
  [DbLoopMode.QUEUE]: 'queue',
};

export interface PersistedQueue {
  readonly tracks: readonly QueuedTrack[];
  readonly currentIndex: number;
  readonly loopMode: LoopMode;
  readonly volume: number;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
}

export interface HistorySeed {
  readonly identifier: string;
  readonly author: string;
  readonly title: string;
}

export class QueueStore {
  readonly #prisma: PrismaClient;
  readonly #pendingSaves = new Map<string, NodeJS.Timeout>();

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /** Schedule a debounced snapshot of the queue for this guild. */
  scheduleSave(
    discordGuildId: string,
    queue: TrackQueue,
    state: {
      readonly volume: number;
      readonly paused: boolean;
      readonly voiceChannelId: string | null;
      readonly textChannelId: string | null;
    },
  ): void {
    const existing = this.#pendingSaves.get(discordGuildId);
    if (existing !== undefined) clearTimeout(existing);

    // Snapshot now: the queue may mutate again before the timer fires, and a
    // fresh mutation reschedules with a fresh snapshot anyway.
    const snapshot = {
      tracks: [...queue.tracks],
      currentIndex: queue.currentIndex,
      loopMode: queue.loopMode,
      ...state,
    };

    const timer = setTimeout(() => {
      this.#pendingSaves.delete(discordGuildId);
      this.#save(discordGuildId, snapshot).catch((error: unknown) => {
        logger.warn({ err: error, guildId: discordGuildId }, 'Queue persistence failed');
      });
    }, SAVE_DEBOUNCE_MS);
    timer.unref();

    this.#pendingSaves.set(discordGuildId, timer);
  }

  /** Flush a pending save immediately (shutdown path). */
  async flush(discordGuildId: string, queue: TrackQueue, paused: boolean): Promise<void> {
    const existing = this.#pendingSaves.get(discordGuildId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.#pendingSaves.delete(discordGuildId);
    }
    await this.#save(discordGuildId, {
      tracks: [...queue.tracks],
      currentIndex: queue.currentIndex,
      loopMode: queue.loopMode,
      volume: 100,
      paused,
      voiceChannelId: null,
      textChannelId: null,
    }).catch((error: unknown) => {
      logger.warn({ err: error, guildId: discordGuildId }, 'Queue flush failed');
    });
  }

  async #save(
    discordGuildId: string,
    snapshot: {
      readonly tracks: readonly QueuedTrack[];
      readonly currentIndex: number;
      readonly loopMode: LoopMode;
      readonly volume: number;
      readonly paused: boolean;
      readonly voiceChannelId: string | null;
      readonly textChannelId: string | null;
    },
  ): Promise<void> {
    const guild = await this.#prisma.guild.findUnique({
      where: { discordId: discordGuildId },
      select: { id: true, queue: { select: { id: true } } },
    });
    if (guild === null) return;

    const queueId =
      guild.queue?.id ??
      (await this.#prisma.queue.create({ data: { guildId: guild.id }, select: { id: true } })).id;

    // Replace-all inside one transaction: simplest correct model for a list
    // that reorders arbitrarily, and queue sizes are bounded by LIMITS.
    await this.#prisma.$transaction([
      this.#prisma.queueTrack.deleteMany({ where: { queueId } }),
      this.#prisma.queue.update({
        where: { id: queueId },
        data: {
          currentIndex: Math.max(snapshot.currentIndex, 0),
          loopMode: TO_DB_LOOP[snapshot.loopMode],
          volume: snapshot.volume,
          paused: snapshot.paused,
          voiceChannelId: snapshot.voiceChannelId,
          textChannelId: snapshot.textChannelId,
        },
      }),
      ...(snapshot.tracks.length > 0
        ? [
            this.#prisma.queueTrack.createMany({
              data: snapshot.tracks.map((track, position) => ({
                queueId,
                position,
                encoded: track.encoded,
                identifier: track.identifier,
                title: track.title,
                author: track.author,
                durationMs: track.durationMs,
                uri: track.uri,
                artworkUrl: track.artworkUrl,
                isStream: track.isStream,
                source: TO_DB_SOURCE[track.source],
              })),
            }),
          ]
        : []),
    ]);
  }

  /**
   * Recent plays for a guild — autoplay's seed and dedup source.
   * Newest first; failures return an empty list (autoplay just parks).
   */
  async recentHistory(discordGuildId: string, limit: number): Promise<readonly HistorySeed[]> {
    try {
      const rows = await this.#prisma.songHistory.findMany({
        where: { guild: { discordId: discordGuildId } },
        orderBy: { playedAt: 'desc' },
        take: limit,
        select: { identifier: true, author: true, title: true },
      });
      return rows;
    } catch (error) {
      logger.warn({ err: error, guildId: discordGuildId }, 'History read failed');
      return [];
    }
  }

  /**
   * Load the persisted queue for one guild, for restoring after a restart.
   * Null when there is nothing worth restoring (no tracks or no channel).
   */
  async loadPersisted(discordGuildId: string): Promise<PersistedQueue | null> {
    const queue = await this.#prisma.queue.findFirst({
      where: { guild: { discordId: discordGuildId } },
      include: { tracks: { orderBy: { position: 'asc' } } },
    });
    if (queue?.voiceChannelId == null || queue.tracks.length === 0) return null;

    return {
      tracks: queue.tracks.map((track) => ({
        encoded: track.encoded,
        identifier: track.identifier,
        title: track.title,
        author: track.author,
        durationMs: track.durationMs,
        uri: track.uri,
        artworkUrl: track.artworkUrl,
        isStream: track.isStream,
        source: FROM_DB_SOURCE[track.source],
        requestedById: '0',
        requestedByName: 'Restored',
      })),
      currentIndex: Math.min(queue.currentIndex, queue.tracks.length - 1),
      loopMode: FROM_DB_LOOP[queue.loopMode],
      volume: queue.volume,
      voiceChannelId: queue.voiceChannelId,
      textChannelId: queue.textChannelId ?? '',
    };
  }

  /** Discord guild ids configured for 24/7 that have a restorable queue. */
  async stayConnectedGuildIds(): Promise<readonly string[]> {
    const guilds = await this.#prisma.guild.findMany({
      where: {
        botLeftAt: null,
        settings: { stayConnected: true },
        queue: { voiceChannelId: { not: null } },
      },
      select: { discordId: true },
    });
    return guilds.map((guild) => guild.discordId);
  }

  /** Append one play to the analytics history. Best-effort. */
  async recordHistory(
    discordGuildId: string,
    track: QueuedTrack,
    outcome: { readonly playedMs: number; readonly skipped: boolean },
  ): Promise<void> {
    try {
      const guild = await this.#prisma.guild.findUnique({
        where: { discordId: discordGuildId },
        select: { id: true },
      });
      if (guild === null) return;

      const user = await this.#prisma.user.findUnique({
        where: { discordId: track.requestedById },
        select: { id: true },
      });

      await this.#prisma.songHistory.create({
        data: {
          guildId: guild.id,
          userId: user?.id ?? null,
          identifier: track.identifier,
          title: track.title,
          author: track.author,
          durationMs: track.durationMs,
          uri: track.uri,
          source: TO_DB_SOURCE[track.source],
          playedMs: Math.max(0, Math.round(outcome.playedMs)),
          skipped: outcome.skipped,
        },
      });
    } catch (error) {
      logger.warn({ err: error, guildId: discordGuildId }, 'History write failed');
    }
  }
}

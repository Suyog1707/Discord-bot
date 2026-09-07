/**
 * Queue persistence + song history.
 *
 * Write-through with debounce: every mutation schedules a save; rapid
 * mutations (queueing a playlist) collapse into one write. The DB copy powers
 * the dashboard's queue view and survives restarts; the in-memory TrackQueue
 * remains the source of truth while the bot is live.
 *
 * A queue belongs to a VOICE CHANNEL, not to a guild. Discord only lets the
 * bot occupy one channel per guild at a time, but that is a limit on playback,
 * not on memory: each channel keeps its own list, so moving the bot to another
 * channel parks the first room's queue rather than destroying it, and coming
 * back resumes it. Everything below is therefore keyed by the pair.
 */
import {
  MusicSource as DbMusicSource,
  LoopMode as DbLoopMode,
  type PrismaClient,
} from '@discord-music/database';
import type { LoopMode, MusicSource } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';
import { trackOrigin, type QueuedTrack, type TrackOrigin } from './track.js';
import type { TrackQueue } from './track-queue.js';

const logger = getLogger('queue-store');

const SAVE_DEBOUNCE_MS = 1_500;

/**
 * Debounce key. Two channels in one guild can both have a save in flight —
 * the bot leaving one and joining the other is exactly that — so the pending
 * timer has to be per room, or the departing channel's write gets cancelled
 * by the arriving one and its queue is lost.
 */
function saveKey(discordGuildId: string, voiceChannelId: string): string {
  return `${discordGuildId}:${voiceChannelId}`;
}

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
  /** Discord id of the primary listener, when one was recorded. */
  readonly listenerId: string | null;
  /** When this queue was last written — how stale a resume would be. */
  readonly savedAt: Date;
}

/** Everything about a queue that is not the track list. */
export interface QueueSaveState {
  readonly volume: number;
  readonly paused: boolean;
  /** Half of the queue's identity, so never optional. */
  readonly voiceChannelId: string;
  readonly textChannelId: string | null;
  /** Discord id of the primary listener; null when nobody has requested yet. */
  readonly listenerId?: string | null;
}

/** A guild in 24/7 mode and the room it was last heard in. */
export interface StayConnectedSession {
  readonly guildId: string;
  readonly voiceChannelId: string;
}

export interface HistorySeed {
  readonly identifier: string;
  readonly author: string;
  readonly title: string;
  /** The catalogue that named the track — what the listener saw it as. */
  readonly source: MusicSource;
  /**
   * Which provider actually supplied the audio. Autoplay needs it to know
   * whether `identifier` is a YouTube video id it can seed a mix with —
   * SoundCloud ids are not, and since SoundCloud became the primary provider
   * `source` no longer answers that question. Null for rows written before the
   * column existed.
   */
  readonly playbackSource: MusicSource | null;
  /** Who put it on: a person or the recommender. Anchors are 'user' only. */
  readonly origin: 'user' | 'autoplay';
  /** Whether the listener skipped it. Skips never become anchors. */
  readonly skipped: boolean;
}

export class QueueStore {
  readonly #prisma: PrismaClient;
  readonly #pendingSaves = new Map<string, NodeJS.Timeout>();

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /** Schedule a debounced snapshot of one channel's queue. */
  scheduleSave(discordGuildId: string, queue: TrackQueue, state: QueueSaveState): void {
    const key = saveKey(discordGuildId, state.voiceChannelId);
    const existing = this.#pendingSaves.get(key);
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
      this.#pendingSaves.delete(key);
      this.#save(discordGuildId, snapshot).catch((error: unknown) => {
        logger.warn(
          { err: error, guildId: discordGuildId, voiceChannelId: state.voiceChannelId },
          'Queue persistence failed',
        );
      });
    }, SAVE_DEBOUNCE_MS);
    timer.unref();

    this.#pendingSaves.set(key, timer);
  }

  /** Flush a pending save immediately (shutdown and channel-change paths). */
  async flush(
    discordGuildId: string,
    queue: TrackQueue,
    paused: boolean,
    listenerId: string | null,
    channels: { readonly voiceChannelId: string; readonly textChannelId: string | null },
  ): Promise<void> {
    const key = saveKey(discordGuildId, channels.voiceChannelId);
    const existing = this.#pendingSaves.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.#pendingSaves.delete(key);
    }
    await this.#save(discordGuildId, {
      tracks: [...queue.tracks],
      currentIndex: queue.currentIndex,
      loopMode: queue.loopMode,
      volume: 100,
      paused,
      // The channel is what the queue is FILED under, as well as what the
      // 24/7 restore rejoins by. A graceful shutdown that erased it made
      // every 24/7 queue unrestorable — the restore path only ever ran after
      // a crash.
      voiceChannelId: channels.voiceChannelId,
      textChannelId: channels.textChannelId,
      listenerId,
    }).catch((error: unknown) => {
      logger.warn(
        { err: error, guildId: discordGuildId, voiceChannelId: channels.voiceChannelId },
        'Queue flush failed',
      );
    });
  }

  /**
   * Internal User row ids for a set of Discord ids. Restoring a queue needs
   * the requester of every track — that is where listener identity comes from
   * after a restart — and the rows reference internal ids. One query for the
   * whole queue, never one per track; people the database has not met are
   * simply unattributed (recordHistory creates their row the first time a
   * track they requested ends).
   */
  async #userIdsFor(discordIds: ReadonlySet<string>): Promise<ReadonlyMap<string, string>> {
    const ids = [...discordIds].filter((id) => /^\d{15,22}$/u.test(id));
    if (ids.length === 0) return new Map();
    const rows = await this.#prisma.user.findMany({
      where: { discordId: { in: ids } },
      select: { id: true, discordId: true },
    });
    return new Map(rows.map((row) => [row.discordId, row.id]));
  }

  async #save(
    discordGuildId: string,
    snapshot: {
      readonly tracks: readonly QueuedTrack[];
      readonly currentIndex: number;
      readonly loopMode: LoopMode;
      readonly volume: number;
      readonly paused: boolean;
      readonly voiceChannelId: string;
      readonly textChannelId: string | null;
      readonly listenerId?: string | null;
    },
  ): Promise<void> {
    const guild = await this.#prisma.guild.findUnique({
      where: { discordId: discordGuildId },
      select: { id: true },
    });
    if (guild === null) return;

    // Find-or-create this room's row. The upsert writes nothing but the
    // identity: the transaction below owns every mutable field, and doing it
    // here as well would make the two disagree for the width of one query.
    const { id: queueId } = await this.#prisma.queue.upsert({
      where: {
        guildId_voiceChannelId: { guildId: guild.id, voiceChannelId: snapshot.voiceChannelId },
      },
      update: {},
      create: { guildId: guild.id, voiceChannelId: snapshot.voiceChannelId },
      select: { id: true },
    });

    const people = new Set<string>();
    for (const track of snapshot.tracks) {
      if (trackOrigin(track) === 'user') people.add(track.requestedById);
    }
    if (snapshot.listenerId != null) people.add(snapshot.listenerId);
    const userIds = await this.#userIdsFor(people);
    const listenerRowId =
      snapshot.listenerId == null ? null : (userIds.get(snapshot.listenerId) ?? null);

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
          listenerId: listenerRowId,
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
                playbackSource:
                  track.playbackSource === undefined ? null : TO_DB_SOURCE[track.playbackSource],
                origin: trackOrigin(track),
                autoplayKind: track.autoplayKind ?? null,
                sourceKey: track.sourceKey ?? null,
                requestedById:
                  trackOrigin(track) === 'user' ? (userIds.get(track.requestedById) ?? null) : null,
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
  async recentHistory(
    discordGuildId: string,
    limit: number,
    voiceChannelId?: string,
  ): Promise<readonly HistorySeed[]> {
    try {
      /**
       * A room's own past, topped up with the server's.
       *
       * Autoplay reads this to decide what not to repeat and what to seed
       * from, and two channels sharing one history makes them one crowd —
       * each spending the other's anti-repeat and seeding from the other's
       * music. But a channel that has only just started playing has almost no
       * past of its own, and seeding from nothing is worse than seeding from
       * the server's taste. So the room leads and the guild fills the gap.
       */
      const rows = await this.#readHistory(discordGuildId, limit, voiceChannelId);
      const rest =
        voiceChannelId === undefined || rows.length >= limit
          ? []
          : await this.#readHistory(discordGuildId, limit - rows.length, undefined, voiceChannelId);
      return [...rows, ...rest];
    } catch (error) {
      logger.warn({ err: error, guildId: discordGuildId }, 'History read failed');
      return [];
    }
  }

  async #readHistory(
    discordGuildId: string,
    limit: number,
    voiceChannelId?: string,
    excludeVoiceChannelId?: string,
  ): Promise<readonly HistorySeed[]> {
    if (limit <= 0) return [];
    {
      const rows = await this.#prisma.songHistory.findMany({
        where: {
          guild: { discordId: discordGuildId },
          ...(voiceChannelId === undefined ? {} : { voiceChannelId }),
          ...(excludeVoiceChannelId === undefined
            ? {}
            : { NOT: { voiceChannelId: excludeVoiceChannelId } }),
        },
        orderBy: { playedAt: 'desc' },
        take: limit,
        select: {
          identifier: true,
          author: true,
          title: true,
          source: true,
          playbackSource: true,
          origin: true,
          skipped: true,
        },
      });
      return rows.map((row) => ({
        identifier: row.identifier,
        author: row.author,
        title: row.title,
        source: FROM_DB_SOURCE[row.source],
        playbackSource: row.playbackSource === null ? null : FROM_DB_SOURCE[row.playbackSource],
        origin: row.origin === 'autoplay' ? ('autoplay' as const) : ('user' as const),
        skipped: row.skipped,
      }));
    }
  }

  /**
   * Load one voice channel's saved queue.
   *
   * Null when there is nothing worth restoring — no row for that room, or a
   * row with no tracks left in it.
   */
  async loadPersisted(
    discordGuildId: string,
    voiceChannelId: string,
  ): Promise<PersistedQueue | null> {
    const queue = await this.#prisma.queue.findFirst({
      where: { guild: { discordId: discordGuildId }, voiceChannelId },
      include: {
        listener: { select: { discordId: true } },
        tracks: {
          orderBy: { position: 'asc' },
          include: {
            requestedBy: { select: { discordId: true, username: true, globalName: true } },
          },
        },
      },
    });
    if (queue === null || queue.tracks.length === 0) return null;

    return {
      tracks: queue.tracks.map((track): QueuedTrack => {
        // A track with a recorded requester comes back as theirs; autoplay's
        // own picks come back as autoplay's, with the cadence half they
        // filled. Only rows written before attribution existed are "Restored".
        const origin: TrackOrigin = track.origin === 'autoplay' ? 'autoplay' : 'user';
        const requester = track.requestedBy;
        const kind =
          track.autoplayKind === 'familiar' || track.autoplayKind === 'discovery'
            ? track.autoplayKind
            : undefined;
        return {
          encoded: track.encoded,
          identifier: track.identifier,
          title: track.title,
          author: track.author,
          durationMs: track.durationMs,
          uri: track.uri,
          artworkUrl: track.artworkUrl,
          isStream: track.isStream,
          source: FROM_DB_SOURCE[track.source],
          ...(track.playbackSource === null
            ? {}
            : { playbackSource: FROM_DB_SOURCE[track.playbackSource] }),
          requestedById: origin === 'autoplay' ? '0' : (requester?.discordId ?? '0'),
          requestedByName:
            origin === 'autoplay'
              ? 'Autoplay'
              : (requester?.globalName ?? requester?.username ?? 'Restored'),
          origin,
          ...(kind === undefined ? {} : { autoplayKind: kind }),
          ...(track.sourceKey === null ? {} : { sourceKey: track.sourceKey }),
        };
      }),
      currentIndex: Math.min(queue.currentIndex, queue.tracks.length - 1),
      loopMode: FROM_DB_LOOP[queue.loopMode],
      volume: queue.volume,
      voiceChannelId: queue.voiceChannelId,
      textChannelId: queue.textChannelId ?? '',
      listenerId: queue.listener?.discordId ?? null,
      savedAt: queue.updatedAt,
    };
  }

  /**
   * Rooms to rejoin on startup: for each 24/7 guild, the voice channel it was
   * most recently playing in.
   *
   * One channel per guild, because the bot can only be in one. A guild whose
   * other channels have saved queues keeps them — they resume the next time
   * somebody starts the bot in that channel.
   */
  async stayConnectedSessions(): Promise<readonly StayConnectedSession[]> {
    const guilds = await this.#prisma.guild.findMany({
      where: {
        botLeftAt: null,
        settings: { stayConnected: true },
        queues: { some: {} },
      },
      select: {
        discordId: true,
        queues: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { voiceChannelId: true },
        },
      },
    });

    return guilds.flatMap((guild) => {
      const [latest] = guild.queues;
      return latest === undefined
        ? []
        : [{ guildId: guild.discordId, voiceChannelId: latest.voiceChannelId }];
    });
  }

  /** Append one play to the analytics history. Best-effort. */
  async recordHistory(
    discordGuildId: string,
    voiceChannelId: string,
    track: QueuedTrack,
    outcome: { readonly playedMs: number; readonly skipped: boolean },
  ): Promise<void> {
    try {
      const guild = await this.#prisma.guild.findUnique({
        where: { discordId: discordGuildId },
        select: { id: true },
      });
      if (guild === null) return;

      // The requester's User row is CREATED here when it does not exist yet,
      // not merely looked up. Personalised autoplay reads history per
      // listener, and a listener who has never opened the dashboard or saved
      // a favourite had no User row — so every play they ever requested was
      // recorded with a null userId and was invisible to their own profile.
      // Only real people get a row: autoplay's picks are attributed to the
      // bot, and a restored queue's "0" requester is nobody.
      const requesterId = track.requestedById;
      const isPerson = trackOrigin(track) === 'user' && /^\d{15,22}$/u.test(requesterId);
      // The upsert is not atomic against a concurrent first insert: two of a
      // new listener's tracks ending together can both take the create branch,
      // and the loser must not drop the play — it is that person's first row.
      const user = isPerson
        ? await this.#prisma.user
            .upsert({
              where: { discordId: requesterId },
              update: {},
              create: { discordId: requesterId, username: track.requestedByName },
              select: { id: true },
            })
            .catch(() =>
              this.#prisma.user.findUnique({
                where: { discordId: requesterId },
                select: { id: true },
              }),
            )
        : null;

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
          playbackSource:
            track.playbackSource === undefined ? null : TO_DB_SOURCE[track.playbackSource],
          playedMs: Math.max(0, Math.round(outcome.playedMs)),
          skipped: outcome.skipped,
          origin: trackOrigin(track),
          voiceChannelId,
        },
      });
    } catch (error) {
      logger.warn({ err: error, guildId: discordGuildId }, 'History write failed');
    }
  }
}

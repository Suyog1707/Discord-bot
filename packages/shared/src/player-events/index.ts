/**
 * Real-time player events, bot → dashboard.
 *
 * The bot is the source of truth for playback. Every state change publishes
 * one event to Redis pub/sub; the dashboard's SSE stream relays it to the
 * browser. Each event carries a **full state snapshot**, not a diff — a
 * client that missed events (reconnect, tab sleep) is correct again on the
 * very next one, with no reconciliation protocol.
 *
 * Commands flow the other way through `player-commands` (validated POST →
 * Redis), so the pair forms a full-duplex control channel.
 */
import { z } from 'zod';

import { REDIS_NAMESPACE, redisKey } from '../constants/index.js';

/** Redis pub/sub channel for player state events. */
export const PLAYER_EVENT_CHANNEL = redisKey(REDIS_NAMESPACE.PLAYER, 'events');

export const PLAYER_EVENT_TYPES = [
  'TRACK_START',
  'TRACK_END',
  'TRACK_PAUSE',
  'TRACK_RESUME',
  'QUEUE_UPDATE',
  'QUEUE_CLEAR',
  'QUEUE_REORDER',
  'PLAYER_CONNECT',
  'PLAYER_DISCONNECT',
  'AUTOPLAY_CHANGE',
  'LISTENER_CHANGE',
  'FILTER_CHANGE',
  'VOLUME_CHANGE',
  'SEEK',
  'LOOP_CHANGE',
  'STAY_CONNECTED_CHANGE',
  'VOICE_MOVE',
] as const;

export type PlayerEventType = (typeof PLAYER_EVENT_TYPES)[number];

const trackSnapshotSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  author: z.string(),
  durationMs: z.number().int().min(0),
  uri: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  isStream: z.boolean(),
  source: z.string(),
  requestedByName: z.string(),
  /**
   * Canonical track identity (`artist::title`, the recommendation engine's
   * key). Carried so a dashboard "not like" names the same song the bot
   * would, whichever provider streamed it and however the upload was titled.
   */
  trackKey: z.string().optional(),
});

export type TrackSnapshot = z.infer<typeof trackSnapshotSchema>;

/**
 * Complete player state at the moment of the event. `positionMs` is paired
 * with `sentAt` so clients can animate progress locally between events.
 */
export const playerSnapshotSchema = z.object({
  current: trackSnapshotSchema.nullable(),
  positionMs: z.number().int().min(0),
  paused: z.boolean(),
  volume: z.number().int().min(0).max(200),
  loopMode: z.enum(['off', 'track', 'queue']),
  autoplayEnabled: z.boolean(),
  stayConnected: z.boolean(),
  activeFilter: z.string().nullable(),
  voiceChannelId: z.string().nullable(),
  /** Discord id of the primary listener autoplay follows; null until someone requests. */
  listenerId: z.string().nullable().optional(),
  /** Upcoming tracks, capped — enough for every dashboard view. */
  upcoming: z.array(trackSnapshotSchema).max(100),
  upcomingTotal: z.number().int().min(0),
});

export type PlayerSnapshot = z.infer<typeof playerSnapshotSchema>;

export const playerEventSchema = z.object({
  type: z.enum(PLAYER_EVENT_TYPES),
  guildId: z.string(),
  sentAt: z.number().int(),
  state: playerSnapshotSchema.nullable(),
});

export type PlayerEvent = z.infer<typeof playerEventSchema>;

export function encodePlayerEvent(event: PlayerEvent): string {
  return JSON.stringify(event);
}

/** Parse + validate an incoming event; null when malformed. */
export function decodePlayerEvent(raw: string): PlayerEvent | null {
  try {
    const result = playerEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

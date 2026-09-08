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
  /**
   * Which room the event is about.
   *
   * A server can play in several voice channels at once, each with its own
   * queue and its own dashboard. Without this, a listener filtering by guild
   * receives every room's events and cannot tell them apart — one room's
   * "track started" would redraw another room's player.
   *
   * The snapshot below carries the same id; this one is on the envelope so a
   * subscriber can route without parsing the state, and so a disconnect event
   * — whose state is null — still says which room went quiet.
   */
  voiceChannelId: z.string(),
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

/**
 * Redis key holding the latest full snapshot for one room.
 *
 * Because every published event is a **complete** state snapshot rather than a
 * diff, retaining only the most recent one is all a late-joining dashboard
 * needs: the value under this key is, by construction, exactly what the client
 * would have converged to had it been listening the whole time. There is no
 * log to replay and no ordering to reconcile — the newest write wins.
 *
 * Keyed by room, not by server. One bot owns one room, so there is still
 * exactly one writer per key — the property that makes last-write-wins safe.
 * Keyed by server it would have several, and worse: a disconnect in one room
 * deletes the key, which would blank every other room for any dashboard that
 * connected afterwards.
 */
export function playerStateKey(guildId: string, voiceChannelId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'state', guildId, voiceChannelId);
}

/**
 * Redis set naming the rooms a server currently has playing.
 *
 * The dashboard needs to enumerate rooms before it knows their ids, and
 * scanning Redis for keys is not something to do on a page load. The bot adds
 * a room on connect and removes it on disconnect.
 */
/**
 * Redis key naming which bot serves one room, and how to reach it.
 *
 * The room snapshots say what is playing; this says *who* is playing it. Once
 * each bot has its own container, a command about a room may arrive at a
 * container that does not own it, and this is how it finds the one that does
 * without asking every sibling in turn.
 *
 * Written by the owner when it takes a room and removed when it lets go, with
 * the same TTL as the snapshot so a container that died without saying goodbye
 * cannot be addressed forever.
 */
export function playerRoomOwnerKey(guildId: string, voiceChannelId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'owner', guildId, voiceChannelId);
}

export function playerRoomIndexKey(guildId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'rooms', guildId);
}

/**
 * Expiry for the retained snapshot.
 *
 * Disconnects delete the key outright, so this TTL is not the normal cleanup
 * path — it only reaps guilds whose bot process died without ever emitting a
 * disconnect event, so a stale "playing" snapshot cannot haunt the dashboard
 * forever. Long enough to comfortably outlive a full listening session.
 */
export const PLAYER_STATE_TTL_SECONDS = 6 * 60 * 60;

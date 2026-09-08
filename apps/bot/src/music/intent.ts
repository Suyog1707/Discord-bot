/**
 * What one container asks another to do with a room.
 *
 * A room is owned by exactly one bot, and once each bot has its own container
 * that owner may not be the one holding the interaction. The naive fix — call
 * `player.skip()` down a wire — does not survive contact with this codebase:
 * `player.queue` is read at twenty-odd call sites, one method takes a closure,
 * and two take callbacks that mutate the player. None of that can cross a
 * process boundary.
 *
 * So the *whole intent* crosses instead, once, and runs locally on the owner
 * where all of that already works. One round trip per user action rather than
 * hundreds, and everything awkward stays in-process.
 *
 * This is deliberately a bot-to-bot contract and lives here rather than in
 * `@discord-music/shared`: the dashboard has its own, narrower command schema
 * (`playerCommandSchema`) and must not gain the ability to send internal
 * intents just because they happen to share a transport.
 */
import { LIMITS, z } from '@discord-music/shared';
import type { PlayerSnapshot } from '@discord-music/shared';

import type { QueuedTrack } from './track.js';

/**
 * Every intent names the room it acts on, and who asked.
 *
 * Plain strings rather than the branded snowflake schema the dashboard uses.
 * These ids come straight off Discord objects the caller already holds, so the
 * regex would guard against nothing a missing room does not already catch —
 * and branding an internal contract makes every call site fight the compiler
 * over values it got from discord.js in the first place.
 */
const id = z.string().min(1).max(32);
const target = { guildId: id, voiceChannelId: id, issuedBy: id } as const;

const position = z.number().int().min(1).max(LIMITS.QUEUE_MAX_TRACKS);

export const roomIntentSchema = z.discriminatedUnion('action', [
  /* ------------------------------------------------------------- transport */
  z.object({ action: z.literal('pause'), ...target }),
  z.object({ action: z.literal('resume'), ...target }),
  z.object({ action: z.literal('skip'), ...target }),
  z.object({ action: z.literal('stop'), ...target }),
  z.object({ action: z.literal('previous'), ...target }),
  z.object({ action: z.literal('restart'), ...target }),
  z.object({ action: z.literal('shuffle'), ...target }),
  z.object({
    action: z.literal('volume'),
    ...target,
    volume: z.number().int().min(LIMITS.VOLUME_MIN).max(LIMITS.VOLUME_MAX),
  }),
  z.object({ action: z.literal('seek'), ...target, positionMs: z.number().int().min(0) }),
  z.object({
    action: z.literal('loop'),
    ...target,
    mode: z.enum(['off', 'track', 'queue']),
  }),

  /* ----------------------------------------------------------------- queue */
  z.object({ action: z.literal('jump'), ...target, position }),
  z.object({ action: z.literal('remove'), ...target, position }),
  z.object({ action: z.literal('move'), ...target, from: position, to: position }),
  z.object({ action: z.literal('swap'), ...target, a: position, b: position }),
  z.object({ action: z.literal('clear'), ...target }),

  /* --------------------------------------------------------------- session */
  z.object({ action: z.literal('set-listener'), ...target, listenerId: id.nullable() }),
  z.object({ action: z.literal('stay-connected'), ...target, enabled: z.boolean() }),
  z.object({ action: z.literal('autoplay'), ...target, enabled: z.boolean() }),

  /* -------------------------------------------------------------- dislikes */
  z.object({
    action: z.literal('dislike'),
    ...target,
    trackKey: z.string().min(1),
    skipIfPlaying: z.boolean().default(true),
  }),
  z.object({ action: z.literal('undislike'), ...target, trackKey: z.string().min(1) }),

  /* ------------------------------------------------------------------ reads */
  z.object({ action: z.literal('snapshot'), ...target }),
  /**
   * The room's DJ state, for the command guard.
   *
   * Exactly three values, all scalars — `decideDjAuthority` is already a pure
   * function, so this is the only thing the guard needs from a room it does
   * not own.
   */
  z.object({ action: z.literal('authority'), ...target }),
]);

export type RoomIntent = z.infer<typeof roomIntentSchema>;
export type RoomIntentAction = RoomIntent['action'];

/** Enough of a track to render a reply, without shipping the whole object. */
export interface TrackSummary {
  readonly title: string;
  readonly author: string;
  readonly identifier: string;
  readonly uri: string | null;
}

export function summarise(track: QueuedTrack | null): TrackSummary | null {
  if (track === null) return null;
  return {
    title: track.title,
    author: track.author,
    identifier: track.identifier,
    uri: track.uri,
  };
}

/**
 * What an intent produces.
 *
 * Deliberately a small closed set rather than one shape per action: the caller
 * only ever needs enough to render a reply, and a narrow union is far easier
 * to keep serialisable than twenty bespoke payloads.
 */
export type IntentResult =
  /** Done; nothing to report beyond that it worked. */
  | { readonly kind: 'ok' }
  /** An action whose subject is a track — skip, jump, previous, remove. */
  | { readonly kind: 'track'; readonly track: TrackSummary | null }
  /** An action that acted on some number of tracks — clear, shuffle. */
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'snapshot'; readonly snapshot: PlayerSnapshot }
  | {
      readonly kind: 'authority';
      readonly botVoiceChannelId: string;
      readonly hostId: string | null;
      readonly sessionDjIds: readonly string[];
    }
  /** The room is gone, or the intent could not be honoured. */
  | { readonly kind: 'error'; readonly message: string };

export function encodeIntent(intent: RoomIntent): string {
  return JSON.stringify(intent);
}

/** Parse and validate an incoming intent; null when malformed. */
export function decodeIntent(raw: unknown): RoomIntent | null {
  const result = roomIntentSchema.safeParse(raw);
  return result.success ? result.data : null;
}

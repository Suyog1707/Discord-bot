/**
 * What one container sends another when it hands over a room.
 *
 * `JoinOptions` is all plain scalars — a guild, a channel, a shard and two
 * hints — which is the only reason a room can be handed across a process
 * boundary at all. Validated on arrival like anything else off a wire, even
 * though the only caller is a sibling: a malformed body should be a 400, not a
 * bot trying to join channel `undefined`.
 */
import { z } from '@discord-music/shared';

import type { JoinOptions } from './music-manager.js';

const id = z.string().min(1).max(32);

export const joinRequestSchema = z.object({
  guildId: id,
  voiceChannelId: id,
  textChannelId: id,
  shardId: z.number().int().min(0),
  listenerId: id.nullable().optional(),
  resumeSavedQueue: z.boolean().optional(),
});

export function decodeJoinRequest(raw: unknown): JoinOptions | null {
  const result = joinRequestSchema.safeParse(raw);
  if (!result.success) return null;

  // The optional hints are rebuilt rather than spread: under
  // `exactOptionalPropertyTypes` a key present with the value `undefined` is
  // not the same as an absent key, and `JoinOptions` means the latter.
  const { listenerId, resumeSavedQueue, ...target } = result.data;
  return {
    ...target,
    ...(listenerId === undefined ? {} : { listenerId }),
    ...(resumeSavedQueue === undefined ? {} : { resumeSavedQueue }),
  };
}

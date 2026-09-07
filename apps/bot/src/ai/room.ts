/**
 * What autoplay is playing *for*.
 *
 * A server used to be the unit: one guild, one queue, one radio. It can now
 * have several voice channels playing at once, and almost everything autoplay
 * does is about a room rather than a server — who is listening, what just
 * played here, what must not repeat, which songs another pass has already
 * claimed. Two channels sharing any of that would blend their taste and hand
 * each other the same song.
 *
 * A few things stay genuinely server-wide, and the split is worth stating
 * because it is the whole design:
 *
 *   ROOM   — the session ledger, reservations, autoplay buffers, recent plays.
 *   GUILD  — playlists, favourites, dislikes, the long-term taste profile.
 *            These belong to the server and its people; the rooms already
 *            differ because different people are standing in them.
 *
 * Passing both together, rather than a bare id, is what stops the two being
 * confused at a call site.
 */
export interface RoomRef {
  /** `guildId:voiceChannelId` — the key for anything room-scoped. */
  readonly roomId: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
}

export function roomIdOf(guildId: string, voiceChannelId: string): string {
  return `${guildId}:${voiceChannelId}`;
}

export function roomRefOf(guildId: string, voiceChannelId: string): RoomRef {
  return { roomId: roomIdOf(guildId, voiceChannelId), guildId, voiceChannelId };
}

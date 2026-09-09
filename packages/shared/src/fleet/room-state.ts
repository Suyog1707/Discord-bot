/**
 * One room a bot is serving, in a shape that can cross a process boundary.
 *
 * Lives here rather than beside the player it describes because it is a wire
 * type: it is serialised into each container's presence entry in Redis, and
 * read back by anything deciding which bot should take a channel — including
 * the command router, which has no Discord connection and no player at all.
 */
export interface RoomState {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly isPlaying: boolean;
  readonly hasListeners: boolean;
  readonly stayConnected: boolean;
  /** Epoch ms since the room emptied, or null while it has listeners. */
  readonly emptySince: number | null;
}

/**
 * What to clear before joining a voice channel.
 *
 * A join is reached only when the guild has no `GuildPlayer`, so any voice
 * state still standing is a leftover. Discord treats a join into the channel
 * it already believes the bot occupies as a no-op — no `VOICE_SERVER_UPDATE`,
 * so the handshake waits out its full timeout and fails with "The voice
 * connection is not established in 15 seconds". Clearing first makes the join
 * a real state transition.
 *
 * Pure, so the rule can be tested without a gateway, a guild or a node.
 */
export type VoiceCleanup =
  /** Shoukaku kept a connection whose player never reached the manager. */
  | 'connection'
  /** Discord has the bot in a channel with nothing driving it. */
  | 'voice-state'
  /** Nothing is holding voice; join straight away. */
  | 'none';

export function decideVoiceCleanup(input: {
  /** Shoukaku still holds a connection or a player for this guild. */
  readonly shoukakuHoldsGuild: boolean;
  /** Channel Discord currently has this bot in, if any. */
  readonly discordVoiceChannelId: string | null;
}): VoiceCleanup {
  // Shoukaku's own teardown is the one that also tells Discord, so it wins:
  // resetting the gateway state underneath it would strand the connection.
  if (input.shoukakuHoldsGuild) return 'connection';
  if (input.discordVoiceChannelId !== null) return 'voice-state';
  return 'none';
}

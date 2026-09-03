/**
 * Whether the bot may leave the room it is in for the one it was called to.
 *
 * Discord keeps a single voice state per (guild, user), so a bot occupies at
 * most one voice channel per server: being called to a second channel is
 * always a question of *handover*, never of joining as well. The rule is that
 * a room with people still listening in it keeps the bot — otherwise anybody
 * anywhere in the server could take the music away from a channel full of
 * people just by typing `/play`.
 *
 * Pure, so the rule can be tested without a gateway, a guild or a player.
 */
export type HandoverDecision =
  /** Already in the requested channel; nothing to do. */
  | { readonly kind: 'stay' }
  /** The current room is empty — take the bot. */
  | { readonly kind: 'move' }
  /** People are still listening where the bot is. */
  | { readonly kind: 'busy'; readonly listeners: number };

export function decideHandover(input: {
  readonly currentChannelId: string;
  readonly targetChannelId: string;
  /**
   * How many NON-BOT members are in the channel the bot currently occupies.
   * Bots do not listen, so a channel holding nothing but bots is empty for
   * this purpose.
   */
  readonly listenersInCurrent: number;
}): HandoverDecision {
  if (input.currentChannelId === input.targetChannelId) return { kind: 'stay' };
  if (input.listenersInCurrent > 0) {
    return { kind: 'busy', listeners: input.listenersInCurrent };
  }
  return { kind: 'move' };
}

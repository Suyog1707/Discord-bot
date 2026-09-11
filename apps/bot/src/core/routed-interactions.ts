/**
 * What the subscriber knows about a routed command that the command cannot see.
 *
 * A routed interaction is rebuilt from JSON, and what comes out is a stock
 * discord.js interaction — it has nowhere to carry the router's timestamps or
 * the room the router chose. A WeakMap keyed by that object is the side
 * channel: nothing is written onto a class this code does not own, and the
 * entry goes when the interaction does.
 *
 * A gateway interaction has no entry, and that absence is the signal: nothing
 * routed it, so nothing has decided anything on its behalf.
 */
export interface RoutedReceipt {
  /** When the router put the command on this bot's queue. */
  readonly routedAt: number;
  /** When this container took it off. */
  readonly pickedUpAt: number;
  /** The caller's voice channel as the router saw it, or null. */
  readonly voiceChannelId: string | null;
}

const receipts = new WeakMap<object, RoutedReceipt>();

export function markRouted(interaction: object, receipt: RoutedReceipt): void {
  receipts.set(interaction, receipt);
}

export function routedReceiptOf(interaction: object): RoutedReceipt | undefined {
  return receipts.get(interaction);
}

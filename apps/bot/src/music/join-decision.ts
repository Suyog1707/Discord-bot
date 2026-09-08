/**
 * What `/join` should do with the channel it was called into.
 *
 * Three cases, and the interesting one is the middle. A queue is saved per
 * voice channel and restored whenever the bot joins — but restoring only fills
 * the queue, it never starts the music. Playback has always been a side effect
 * of `/play` enqueuing the track it was given, so a channel with a saved queue
 * could be rejoined and would sit there silent. Starting it is the whole point
 * of this command.
 *
 * Pure, so the rule can be read and tested without a gateway or a player.
 */
export type JoinDecision =
  /** Somebody's session is live here; leave it completely alone. */
  | { readonly kind: 'already-playing' }
  /** Joined, but there is nothing to play — not an error, just an empty room. */
  | { readonly kind: 'empty' }
  /** A queue came back with the join; start it from where it stopped. */
  | { readonly kind: 'resume'; readonly fromIndex: number };

export function decideJoin(input: {
  /** Whether a player is already running in this exact channel. */
  readonly isPlaying: boolean;
  /** Whether the restored queue has a track under its cursor. */
  readonly hasCurrentTrack: boolean;
  /** The restored cursor — where playback should pick up. */
  readonly currentIndex: number;
}): JoinDecision {
  // Checked first: a live session outranks anything the caller wanted, and
  // rejoining it would take it over rather than join it.
  if (input.isPlaying) return { kind: 'already-playing' };
  if (!input.hasCurrentTrack) return { kind: 'empty' };
  return { kind: 'resume', fromIndex: input.currentIndex };
}

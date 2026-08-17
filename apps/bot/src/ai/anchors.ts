/**
 * Taste anchors — the anti-drift core of autoplay.
 *
 * The old seeding rule was "the last four tracks played", and it is exactly how
 * a radio drifts: once the first autoplay batch plays, IT becomes the seed set,
 * the next batch orbits it, and within a few generations the session has walked
 * away from everything the listener actually chose. The chain
 * `E → F(from E) → G(from F)` is structural, not a tuning problem.
 *
 * The fix is to make every generation return to the listener's real taste.
 * Seeds are drawn from an anchor pool of USER-originated plays — songs a person
 * explicitly queued, requested, or replayed — and at most one recent
 * autoplay-originated track joins as low-weight session context. Anchors
 * rotate between generations so consecutive batches do not all expand the same
 * two songs, but the pool they rotate over is stable: anchor selection may
 * rotate, user taste must remain stable.
 */
import { trackKeyOf } from './identity.js';
import type { TrackSeed } from './recommender.js';

/** One recent play, as the anchor selector needs to see it. */
export interface AnchorHistoryEntry {
  readonly title: string;
  readonly author: string;
  readonly identifier: string;
  readonly origin: 'user' | 'autoplay';
  readonly skipped: boolean;
}

/** How many distinct user anchors the rotation draws from. */
const ANCHOR_POOL_SIZE = 10;
/** Seeds handed to the recommender (its own MAX_SEEDS is the hard cap). */
const ANCHOR_SEED_COUNT = 3;
/**
 * Weight of the one autoplay-originated context seed. Well under an anchor's
 * 1.0: the previous recommendation may colour the next batch, never drive it.
 */
const AUTOPLAY_CONTEXT_WEIGHT = 0.4;

function seedOf(entry: AnchorHistoryEntry, weight?: number): TrackSeed {
  return {
    title: entry.title,
    artist: entry.author,
    identifier: entry.identifier,
    ...(weight === undefined ? {} : { weight }),
  };
}

/**
 * Build the seed set for one autoplay generation.
 *
 * `history` is newest-first, the current track (if any) prepended by the
 * caller. The result is ordered for the recommender's positional conventions:
 *
 * - `seeds[0]` is the NEWEST user anchor — stable between generations, so the
 *   prefetch buffer's seed identity survives until the user actually chooses
 *   something new, instead of thrashing on every rotation.
 * - One or two more anchors follow, rotated pseudo-randomly across the pool so
 *   repeated generations expand different corners of the listener's taste.
 * - An optional final low-weight seed is the newest autoplay play: session
 *   context, discounted so it cannot become the next batch's primary source.
 *
 * When the recent window holds no user-originated plays at all (a session
 * restored from nothing but autoplay), the newest plays are used at reduced
 * weight — the long-term profile then does the anchoring on its own.
 */
export function selectAutoplaySeeds(
  history: readonly AnchorHistoryEntry[],
  random: () => number = Math.random,
): TrackSeed[] {
  // Dedupe by canonical song, newest occurrence wins, skips never anchor.
  const seen = new Set<string>();
  const userPool: AnchorHistoryEntry[] = [];
  const autoplayPool: AnchorHistoryEntry[] = [];
  for (const entry of history) {
    if (entry.skipped) continue;
    const key = trackKeyOf(entry.author, entry.title);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.origin === 'user') {
      if (userPool.length < ANCHOR_POOL_SIZE) userPool.push(entry);
    } else if (autoplayPool.length < ANCHOR_POOL_SIZE) {
      autoplayPool.push(entry);
    }
  }

  if (userPool.length === 0) {
    // No user taste in the window: seed from what there is, at context weight,
    // and let the taste profile carry the anchoring.
    return autoplayPool
      .slice(0, ANCHOR_SEED_COUNT)
      .map((entry) => seedOf(entry, AUTOPLAY_CONTEXT_WEIGHT));
  }

  const lead = userPool[0];
  const seeds: TrackSeed[] = lead === undefined ? [] : [seedOf(lead)];

  // Rotate the remaining anchors: sample without replacement from the rest of
  // the pool, so back-to-back generations do not expand identical seeds.
  const rest = userPool.slice(1);
  while (seeds.length < ANCHOR_SEED_COUNT && rest.length > 0) {
    const picked = rest.splice(Math.floor(random() * rest.length), 1)[0];
    if (picked !== undefined) seeds.push(seedOf(picked));
  }

  // The newest autoplay play joins as discounted context — compatibility with
  // what just played matters, dominance by it is the failure mode.
  const context = autoplayPool[0];
  if (context !== undefined) seeds.push(seedOf(context, AUTOPLAY_CONTEXT_WEIGHT));

  return seeds;
}

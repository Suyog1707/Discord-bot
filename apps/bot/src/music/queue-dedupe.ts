/**
 * "Add the ones that aren't already queued."
 *
 * Queueing a Spotify playlist on top of a queue that already holds half of it
 * should add the other half, not a second copy of everything. Filtering happens
 * on the Spotify metadata, before resolution, which is also where it is
 * cheapest: every candidate that survives costs one Lavalink search, and a
 * duplicate is a search whose only outcome is a track nobody wanted twice.
 *
 * Two tracks are the same when either matches:
 *
 *   - the Spotify track id, for anything carrying a Spotify URL. Exact, and it
 *     survives the resolution step because a matched track keeps its Spotify
 *     identity rather than degrading into the provider result it streams from.
 *   - the canonical artist+title key, which is what catches the same song
 *     queued earlier from YouTube or SoundCloud, where no Spotify id exists to
 *     compare. `trackKeyOf` already normalises the decorations that make
 *     provider titles differ ("(Official Video)", "- Topic", feat. spellings).
 *
 * The canonical key is deliberately loose. It will treat a remaster and its
 * original as one song, and a live version whose title says so as a different
 * one. For "don't queue this twice" that is the right side to err on — the cost
 * of a wrong match is one track missing from a playlist the listener can
 * re-add, and the cost of missing a match is the duplicate this exists to
 * prevent.
 */
import { trackKeyOf } from '../ai/identity.js';

import type { QueuedTrack } from './track.js';

/** The Spotify metadata shape this filters, before anything is resolved. */
export interface DedupeCandidate {
  readonly title: string;
  readonly artist: string;
  readonly uri: string | null;
}

export interface DedupeResult<T> {
  /** Candidates not already present, in their original order. */
  readonly keep: readonly T[];
  /** How many were dropped as already-queued or repeated within the batch. */
  readonly skipped: number;
}

/** `https://open.spotify.com/track/ID` / `spotify:track:ID` → `spotify:ID`. */
function spotifyKeyOf(uri: string | null): string | null {
  if (uri === null) return null;
  const match = /(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]+)/u.exec(uri);
  return match?.[1] === undefined ? null : `spotify:${match[1]}`;
}

/** Every key by which an already-queued track should be recognised. */
function keysOf(track: Pick<QueuedTrack, 'title' | 'author' | 'uri'>): string[] {
  const keys = [trackKeyOf(track.author, track.title)];
  const spotifyKey = spotifyKeyOf(track.uri);
  if (spotifyKey !== null) keys.push(spotifyKey);
  return keys;
}

/**
 * Build the set of keys already represented in a queue.
 *
 * The whole queue, not just what is upcoming: a track that already played is
 * still "in this queue" to the person looking at it, and re-adding it because
 * the cursor moved past would be the same duplicate by another route.
 */
export function queuedKeys(tracks: readonly QueuedTrack[]): Set<string> {
  const keys = new Set<string>();
  for (const track of tracks) {
    for (const key of keysOf(track)) keys.add(key);
  }
  return keys;
}

/**
 * Drop candidates already present in `existing`, and repeats within the batch.
 *
 * @param existing - Keys from {@link queuedKeys}. Mutated: each kept candidate
 *   is added, so a playlist listing the same track twice yields it once.
 */
export function withoutQueued<T extends DedupeCandidate>(
  candidates: readonly T[],
  existing: Set<string>,
): DedupeResult<T> {
  const keep: T[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const canonical = trackKeyOf(candidate.artist, candidate.title);
    const spotifyKey = spotifyKeyOf(candidate.uri);

    if (existing.has(canonical) || (spotifyKey !== null && existing.has(spotifyKey))) {
      skipped += 1;
      continue;
    }

    existing.add(canonical);
    if (spotifyKey !== null) existing.add(spotifyKey);
    keep.push(candidate);
  }

  return { keep, skipped };
}

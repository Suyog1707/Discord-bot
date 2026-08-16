/**
 * Pure queue state machine — no Discord, no Lavalink, no I/O.
 *
 * All ordering rules live here so they can be unit-tested exhaustively:
 * loop semantics, shuffle fairness, bounds checking, and the difference
 * between a natural advance (respects `track` loop) and a user skip
 * (never repeats the current track).
 */
import { LIMITS, type LoopMode } from '@discord-music/shared';

import type { QueuedTrack } from './track.js';

export class QueueFullError extends Error {
  constructor(readonly capacity: number) {
    super(`The queue is full (${String(capacity)} tracks).`);
    this.name = 'QueueFullError';
  }
}

export class TrackQueue {
  #tracks: QueuedTrack[] = [];
  /** Index of the current track; -1 when nothing has started yet. */
  #currentIndex = -1;
  #loopMode: LoopMode = 'off';

  readonly capacity: number;

  constructor(capacity: number = LIMITS.QUEUE_MAX_TRACKS) {
    this.capacity = capacity;
  }

  /* ------------------------------------------------------------------ reads */

  get loopMode(): LoopMode {
    return this.#loopMode;
  }

  set loopMode(mode: LoopMode) {
    this.#loopMode = mode;
  }

  get currentIndex(): number {
    return this.#currentIndex;
  }

  get current(): QueuedTrack | null {
    return this.#tracks[this.#currentIndex] ?? null;
  }

  /** Every track, played and upcoming, in order. */
  get tracks(): readonly QueuedTrack[] {
    return this.#tracks;
  }

  /** Tracks after the current position. */
  get upcoming(): readonly QueuedTrack[] {
    return this.#tracks.slice(this.#currentIndex + 1);
  }

  get size(): number {
    return this.#tracks.length;
  }

  get isEmpty(): boolean {
    return this.#tracks.length === 0;
  }

  /** Total remaining duration (current excluded), ignoring live streams. */
  get upcomingDurationMs(): number {
    return this.upcoming.reduce(
      (total, track) => (track.isStream ? total : total + track.durationMs),
      0,
    );
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * Append tracks (or insert right after the current one with `next: true`).
   *
   * @returns The queue position (0-based) of the first added track.
   * @throws {QueueFullError} When the batch would exceed capacity.
   */
  add(tracks: readonly QueuedTrack[], options: { readonly next?: boolean } = {}): number {
    if (this.#tracks.length + tracks.length > this.capacity) {
      throw new QueueFullError(this.capacity);
    }

    if (options.next === true && this.#currentIndex >= 0) {
      const insertAt = this.#currentIndex + 1;
      this.#tracks.splice(insertAt, 0, ...tracks);
      return insertAt;
    }

    this.#tracks.push(...tracks);
    return this.#tracks.length - tracks.length;
  }

  /**
   * Swap the playing track for an equivalent one from another source.
   *
   * In place and at the same index on purpose: the listener asked for this
   * song, and a source that refused to stream it is a detail of delivery, not a
   * change to the queue. Appending instead would duplicate the entry and move
   * everything that follows.
   */
  replaceCurrent(track: QueuedTrack): boolean {
    if (this.#currentIndex < 0 || this.#currentIndex >= this.#tracks.length) return false;
    this.#tracks[this.#currentIndex] = track;
    return true;
  }

  /**
   * Natural advance, called when a track finishes on its own.
   * Honours `track` loop (replays current) and `queue` loop (wraps around).
   */
  advance(): QueuedTrack | null {
    if (this.#tracks.length === 0) return null;

    if (this.#loopMode === 'track' && this.current !== null) {
      return this.current;
    }

    return this.#moveNext();
  }

  /**
   * User-initiated skip: never repeats the current track regardless of loop
   * mode; `queue` loop still wraps at the end.
   */
  skip(): QueuedTrack | null {
    if (this.#tracks.length === 0) return null;
    return this.#moveNext();
  }

  /** Jump to an absolute queue position (0-based). */
  jumpTo(index: number): QueuedTrack | null {
    if (index < 0 || index >= this.#tracks.length) return null;
    this.#currentIndex = index;
    return this.current;
  }

  /** Step back to the previously played track; null at the start of history. */
  previous(): QueuedTrack | null {
    if (this.#currentIndex <= 0) return null;
    this.#currentIndex -= 1;
    return this.current;
  }

  /**
   * Move an upcoming track to another upcoming position (both 0-based within
   * `upcoming`). History and the current track never move.
   */
  moveUpcoming(from: number, to: number): QueuedTrack | null {
    const upcomingCount = this.#tracks.length - (this.#currentIndex + 1);
    if (from < 0 || from >= upcomingCount || to < 0 || to >= upcomingCount) return null;
    if (from === to) return this.upcoming[from] ?? null;

    const base = this.#currentIndex + 1;
    const [moved] = this.#tracks.splice(base + from, 1);
    if (moved === undefined) return null;
    this.#tracks.splice(base + to, 0, moved);
    return moved;
  }

  /** Swap two upcoming tracks (0-based within `upcoming`). */
  swapUpcoming(a: number, b: number): boolean {
    const upcomingCount = this.#tracks.length - (this.#currentIndex + 1);
    if (a < 0 || a >= upcomingCount || b < 0 || b >= upcomingCount) return false;

    const base = this.#currentIndex + 1;
    const trackA = this.#tracks[base + a];
    const trackB = this.#tracks[base + b];
    if (trackA === undefined || trackB === undefined) return false;
    this.#tracks[base + a] = trackB;
    this.#tracks[base + b] = trackA;
    return true;
  }

  #moveNext(): QueuedTrack | null {
    const nextIndex = this.#currentIndex + 1;

    if (nextIndex >= this.#tracks.length) {
      if (this.#loopMode === 'queue' && this.#tracks.length > 0) {
        this.#currentIndex = 0;
        return this.current;
      }
      // Exhausted. Park the cursor past the end so `upcoming` is empty.
      this.#currentIndex = this.#tracks.length;
      return null;
    }

    this.#currentIndex = nextIndex;
    return this.current;
  }

  /**
   * Remove an *upcoming* track by its position in `upcoming` (0-based).
   * The current and already-played tracks are immutable history.
   */
  removeUpcoming(upcomingIndex: number): QueuedTrack | null {
    const absolute = this.#currentIndex + 1 + upcomingIndex;
    if (upcomingIndex < 0 || absolute >= this.#tracks.length) return null;

    const [removed] = this.#tracks.splice(absolute, 1);
    return removed ?? null;
  }

  /** Drop every upcoming track; history and the current track stay. */
  clearUpcoming(): number {
    const removed = this.#tracks.length - (this.#currentIndex + 1);
    this.#tracks.length = Math.max(this.#currentIndex + 1, 0);
    return Math.max(removed, 0);
  }

  /** Reset entirely — used by stop/disconnect. */
  reset(): void {
    this.#tracks = [];
    this.#currentIndex = -1;
    this.#loopMode = 'off';
  }

  /**
   * Fisher–Yates shuffle of the *upcoming* tracks only, so history and the
   * playing track are untouched.
   */
  shuffle(random: () => number = Math.random): void {
    const start = this.#currentIndex + 1;
    for (let index = this.#tracks.length - 1; index > start; index -= 1) {
      const swapWith = start + Math.floor(random() * (index - start + 1));
      const a = this.#tracks[index];
      const b = this.#tracks[swapWith];
      if (a !== undefined && b !== undefined) {
        this.#tracks[index] = b;
        this.#tracks[swapWith] = a;
      }
    }
  }

  /** Restore persisted state (dashboard writes, restarts). */
  restore(tracks: readonly QueuedTrack[], currentIndex: number, loopMode: LoopMode): void {
    this.#tracks = [...tracks];
    this.#currentIndex = Math.min(Math.max(currentIndex, -1), this.#tracks.length);
    this.#loopMode = loopMode;
  }
}

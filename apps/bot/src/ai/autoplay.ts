/**
 * Autoplay with prefetching.
 *
 * The problem this solves is a gap of silence. Generating a recommendation takes
 * a candidate sweep, a ranking pass and a Lavalink search — comfortably a second
 * or two — and doing that only once the queue has already drained means the
 * listener hears the end of one song, then nothing, then the next.
 *
 * So the work starts while the current track is still playing. A small buffer of
 * vetted tracks is kept ready per guild; when the queue drains, autoplay takes
 * from the buffer and the transition is instant. The buffer is refilled in the
 * background, and refilling is deliberately *not* awaited by anything on the
 * playback path.
 *
 * The buffer is intentionally small. Generating a hundred tracks ahead would
 * waste most of them — the listener queues something themselves, changes mood,
 * or leaves — and every wasted candidate is a Lavalink search that competed with
 * real playback for nothing.
 */
import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from '../music/track.js';

import { MusicOrchestrator } from './orchestrator.js';
import type { TrackSeed } from './recommender.js';

const logger = getLogger('autoplay');

/**
 * A buffer older than this is stale: the session has moved on and the picks were
 * chosen to follow music that is now several tracks back.
 */
const BUFFER_TTL_MS = 15 * 60_000;

interface Buffer {
  readonly tracks: QueuedTrack[];
  readonly generatedAt: number;
  /** Seeds the buffer was built from, to detect that the session has drifted. */
  readonly seedKey: string;
}

export interface AutoplayOptions {
  /** How many vetted tracks to keep ready. */
  readonly prefetchSize: number;
}

export class AutoplayEngine {
  readonly #orchestrator: MusicOrchestrator;
  readonly #options: AutoplayOptions;

  readonly #buffers = new Map<string, Buffer>();
  /** In-flight refills, so a burst of track-start events cannot stampede. */
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(orchestrator: MusicOrchestrator, options: AutoplayOptions) {
    this.#orchestrator = orchestrator;
    this.#options = options;
  }

  /**
   * Start filling the buffer for a guild, without blocking the caller.
   *
   * Called when a track starts playing. Returns immediately; the refill runs in
   * the background and its failure is logged, never thrown — a prefetch that
   * fails simply means the next `take` generates synchronously instead.
   */
  prefetch(guildId: string, seeds: readonly TrackSeed[]): void {
    if (seeds.length === 0) return;

    const existing = this.#buffers.get(guildId);
    if (
      existing !== undefined &&
      existing.tracks.length >= this.#options.prefetchSize &&
      existing.seedKey === seedKeyOf(seeds) &&
      Date.now() - existing.generatedAt < BUFFER_TTL_MS
    ) {
      return;
    }

    void this.#refill(guildId, seeds).catch((error: unknown) => {
      logger.debug({ err: error, guildId }, 'Autoplay prefetch failed');
    });
  }

  /**
   * Take up to `count` tracks for a guild that has just run out.
   *
   * Serves from the buffer when it can, which is the whole point — that path is
   * a map lookup rather than a network round trip. Falls through to generating
   * synchronously when the buffer is empty or stale, and returns an empty array
   * rather than throwing when generation itself fails, so the caller's own
   * fallback (a YouTube mix) can take over.
   */
  async take(
    guildId: string,
    count: number,
    seeds: readonly TrackSeed[],
  ): Promise<readonly QueuedTrack[]> {
    const buffered = this.#drain(guildId, count, seeds);
    if (buffered.length > 0) {
      // Refill for next time while the caller is already playing these.
      this.prefetch(guildId, seeds);
      logger.debug({ guildId, served: buffered.length, from: 'buffer' }, 'Autoplay served');
      return buffered;
    }

    // An in-flight prefetch is worth waiting for — it is already most of the way
    // through the work this call would otherwise redo from scratch.
    const pending = this.#inFlight.get(guildId);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
      const afterWait = this.#drain(guildId, count, seeds);
      if (afterWait.length > 0) {
        logger.debug({ guildId, served: afterWait.length, from: 'in-flight' }, 'Autoplay served');
        return afterWait;
      }
    }

    try {
      const result = await this.#generate(guildId, seeds, count);
      logger.debug({ guildId, served: result.length, from: 'synchronous' }, 'Autoplay served');
      return result;
    } catch (error) {
      logger.warn({ err: error, guildId }, 'Autoplay generation failed');
      return [];
    }
  }

  /** Drop a guild's buffer — on stop, disconnect, or a manual queue change. */
  clear(guildId: string): void {
    this.#buffers.delete(guildId);
  }

  #drain(guildId: string, count: number, seeds: readonly TrackSeed[]): readonly QueuedTrack[] {
    const buffer = this.#buffers.get(guildId);
    if (buffer === undefined) return [];

    const stale =
      Date.now() - buffer.generatedAt > BUFFER_TTL_MS || buffer.seedKey !== seedKeyOf(seeds);
    if (stale) {
      this.#buffers.delete(guildId);
      return [];
    }

    const taken = buffer.tracks.splice(0, count);
    if (buffer.tracks.length === 0) this.#buffers.delete(guildId);
    return taken;
  }

  async #refill(guildId: string, seeds: readonly TrackSeed[]): Promise<void> {
    const existing = this.#inFlight.get(guildId);
    if (existing !== undefined) return existing;

    const work = (async () => {
      const tracks = await this.#generate(guildId, seeds, this.#options.prefetchSize);
      if (tracks.length > 0) {
        this.#buffers.set(guildId, {
          tracks: [...tracks],
          generatedAt: Date.now(),
          seedKey: seedKeyOf(seeds),
        });
      }
    })().finally(() => {
      this.#inFlight.delete(guildId);
    });

    this.#inFlight.set(guildId, work);
    return work;
  }

  async #generate(
    guildId: string,
    seeds: readonly TrackSeed[],
    count: number,
  ): Promise<readonly QueuedTrack[]> {
    const result = await this.#orchestrator.recommend({
      guildId,
      seeds,
      count,
      // Autoplay continues a session; there is no sentence to parse, so the
      // intent is synthesised and no LLM is involved at any point here.
      intent: MusicOrchestrator.continuationIntent(count),
    });
    return result.tracks;
  }
}

/**
 * Identity of the seed set.
 *
 * A buffer built while a Punjabi track was playing is the wrong buffer once the
 * room has moved to something else, and comparing seeds is how that is noticed
 * without waiting for the TTL.
 */
function seedKeyOf(seeds: readonly TrackSeed[]): string {
  return seeds
    .slice(0, 2)
    .map((seed) => `${seed.artist}|${seed.title}`.toLowerCase())
    .join('::');
}

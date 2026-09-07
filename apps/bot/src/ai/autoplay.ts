/**
 * Autoplay with prefetching, session state, and reservations.
 *
 * Two problems live here. The first is a gap of silence: generating a
 * recommendation takes a candidate sweep, a ranking pass and a Lavalink search,
 * and doing that only once the queue has drained means the listener hears the
 * end of one song, then nothing. So the work starts while the current track is
 * still playing, into a small per-guild buffer.
 *
 * The second is repetition, and it is why the session store is wired through
 * everything: every generation pass excludes what is playing, queued, reserved
 * and recently played — as HARD exclusions, before ranking — and every pick is
 * atomically reserved before it is resolved, so two passes racing each other
 * cannot select the same song. The original engine had neither: refills
 * regenerated from the same seeds with no memory of what they had already
 * served, and the deterministic pipeline dutifully produced the same list.
 *
 * The LLM reranker runs only on background refills. The synchronous path — a
 * listener waiting in a voice channel — never waits on a model.
 */
import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from '../music/track.js';

import type { AutoplayGenerator } from './autoplay-planner.js';
import { trackKeyOf } from './identity.js';
import { computeAutoplayMetrics } from './metrics.js';
import type { RoomRef } from './room.js';
import type { TrackSeed } from './recommender.js';
import type { AutoplaySessionStore } from './session.js';

const logger = getLogger('autoplay');

/**
 * A buffer older than this is stale: the session has moved on and the picks
 * were chosen to follow music that is now several tracks back.
 */
const BUFFER_TTL_MS = 15 * 60_000;

interface BufferedTrack {
  readonly track: QueuedTrack;
  /** The candidate key this track is reserved under in the session store. */
  readonly reservedKey: string;
}

interface Buffer {
  readonly tracks: BufferedTrack[];
  readonly generatedAt: number;
  /** Seed identity the buffer was built from, to detect session drift. */
  readonly seedKey: string;
}

export interface AutoplayOptions {
  /** How many vetted tracks to keep ready. */
  readonly prefetchSize: number;
}

export class AutoplayEngine {
  readonly #generator: AutoplayGenerator;
  readonly #session: AutoplaySessionStore;
  readonly #options: AutoplayOptions;

  readonly #buffers = new Map<string, Buffer>();
  /**
   * In-flight generation per guild. BOTH the background refill and the
   * synchronous fallback register here, so a take-generate and a refill can
   * never run concurrently for one guild — that overlap was one of the ways
   * the same song got selected twice.
   */
  readonly #inFlight = new Map<string, Promise<void>>();

  /**
   * @param generator - Whatever chooses the songs. In production this is the
   *   `AutoplayPlanner` (known-pool + discovery slots); the engine itself only
   *   knows how to buffer, gate and reserve what it is handed.
   */
  constructor(
    generator: AutoplayGenerator,
    session: AutoplaySessionStore,
    options: AutoplayOptions,
  ) {
    this.#generator = generator;
    this.#session = session;
    this.#options = options;
  }

  /** Read-only view of the session store, for wiring and diagnostics. */
  get session(): AutoplaySessionStore {
    return this.#session;
  }

  /**
   * Start filling the buffer for a guild, without blocking the caller.
   *
   * Called when a track starts playing. Returns immediately; the refill runs in
   * the background and its failure is logged, never thrown — a prefetch that
   * fails simply means the next `take` generates synchronously instead.
   */
  prefetch(room: RoomRef, seeds: readonly TrackSeed[]): void {
    const { roomId } = room;
    if (seeds.length === 0) return;

    // A buffer that still holds at least half its target and follows a track
    // in the CURRENT seed window is good enough — regenerating it would cost a
    // full Last.fm sweep plus Lavalink searches on every single track start,
    // for picks that were fine.
    const existing = this.#buffers.get(roomId);
    if (
      existing !== undefined &&
      existing.tracks.length >= Math.ceil(this.#options.prefetchSize / 2) &&
      seedWindowOf(seeds).has(existing.seedKey) &&
      Date.now() - existing.generatedAt < BUFFER_TTL_MS
    ) {
      // Roll the seed identity forward so the buffer travels with the session
      // instead of "drifting" out of a 4-track window while still perfectly
      // relevant. Staleness stays bounded by the TTL, whose clock is anchored
      // at generation and never reset.
      this.#buffers.set(roomId, { ...existing, seedKey: seedKeyOf(seeds) });
      return;
    }

    void this.#refill(room, seeds).catch((error: unknown) => {
      logger.debug({ err: error, roomId }, 'Autoplay prefetch failed');
    });
  }

  /**
   * Take up to `count` tracks for a guild that has just run out.
   *
   * Serves from the buffer when it can — that path is a map lookup rather than
   * a network round trip. Falls through to generating synchronously (without
   * the LLM pass) when the buffer is empty or stale, and returns an empty
   * array rather than throwing, so the caller's own fallback can take over.
   */
  async take(
    room: RoomRef,
    count: number,
    seeds: readonly TrackSeed[],
  ): Promise<readonly QueuedTrack[]> {
    const { roomId } = room;
    const buffered = this.#drain(roomId, count, seeds);
    if (buffered.length > 0) {
      // Refill for next time while the caller is already playing these.
      this.prefetch(room, seeds);
      logger.debug({ roomId, served: buffered.length, from: 'buffer' }, 'Autoplay served');
      return buffered;
    }

    // An in-flight generation is worth waiting for — it is already most of the
    // way through the work this call would otherwise redo from scratch.
    const pending = this.#inFlight.get(roomId);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
      const afterWait = this.#drain(roomId, count, seeds);
      if (afterWait.length > 0) {
        logger.debug({ roomId, served: afterWait.length, from: 'in-flight' }, 'Autoplay served');
        return afterWait;
      }
    }

    try {
      let served: readonly QueuedTrack[] = [];
      await this.#gated(roomId, async () => {
        served = (await this.#generate(room, seeds, count, { background: false })).map(
          (entry) => entry.track,
        );
      });
      if (served.length === 0) {
        // #gated may have coalesced this call onto a refill that was already
        // in flight, in which case OUR work never ran — but the refill's
        // buffer is sitting right there. Serve from it instead of falling
        // through to the mix path with a silent empty result.
        const coalesced = this.#drain(roomId, count, seeds);
        if (coalesced.length > 0) {
          logger.debug({ roomId, served: coalesced.length, from: 'coalesced' }, 'Autoplay served');
          return coalesced;
        }
      }
      logger.debug({ roomId, served: served.length, from: 'synchronous' }, 'Autoplay served');
      return served;
    } catch (error) {
      logger.warn({ err: error, roomId }, 'Autoplay generation failed');
      return [];
    }
  }

  /**
   * Drop a guild's buffer — on stop, disconnect, or a manual queue change.
   *
   * Buffered tracks' reservations are released so the songs become eligible
   * again; they were never queued, and holding them would punish the next
   * session for picks nobody heard.
   */
  clear(roomId: string): void {
    const buffer = this.#buffers.get(roomId);
    this.#buffers.delete(roomId);
    if (buffer !== undefined && buffer.tracks.length > 0) {
      void this.#session
        .release(
          roomId,
          buffer.tracks.map((entry) => entry.reservedKey),
        )
        .catch(() => undefined);
    }
  }

  /**
   * Drop specific songs from a guild's buffer — an explicit dislike must not
   * be served from a pick chosen a minute earlier. Reservations on the
   * evicted keys are released so nothing keeps holding them.
   */
  evict(roomId: string, keys: ReadonlySet<string>): number {
    const buffer = this.#buffers.get(roomId);
    if (buffer === undefined || keys.size === 0) return 0;
    const evicted = buffer.tracks.filter(
      (entry) =>
        keys.has(entry.reservedKey) || keys.has(trackKeyOf(entry.track.author, entry.track.title)),
    );
    if (evicted.length === 0) return 0;
    const remaining = buffer.tracks.filter((entry) => !evicted.includes(entry));
    if (remaining.length === 0) this.#buffers.delete(roomId);
    else this.#buffers.set(roomId, { ...buffer, tracks: remaining });
    void this.#session
      .release(
        roomId,
        evicted.map((entry) => entry.reservedKey),
      )
      .catch(() => undefined);
    return evicted.length;
  }

  #drain(roomId: string, count: number, seeds: readonly TrackSeed[]): readonly QueuedTrack[] {
    const buffer = this.#buffers.get(roomId);
    if (buffer === undefined) return [];

    // Valid while its seed is anywhere in the current seed window — a buffer
    // built following the PREVIOUS track is still following this session.
    // (The original compared two differently-shaped seed lists for equality,
    // which never matched, so the buffer never served at all.)
    const stale =
      Date.now() - buffer.generatedAt > BUFFER_TTL_MS || !seedWindowOf(seeds).has(buffer.seedKey);
    if (stale) {
      this.clear(roomId);
      return [];
    }

    const taken = buffer.tracks.splice(0, count);
    if (buffer.tracks.length === 0) this.#buffers.delete(roomId);
    // Reservations on served tracks stay: the caller is about to queue them,
    // and the reservation TTL covers the gap until the queue sync sees them.
    return taken.map((entry) => entry.track);
  }

  /** Run `work` as THE generation pass for a guild; concurrent calls coalesce. */
  async #gated(roomId: string, work: () => Promise<void>): Promise<void> {
    const existing = this.#inFlight.get(roomId);
    if (existing !== undefined) return existing;

    const gate = work().finally(() => {
      this.#inFlight.delete(roomId);
    });
    this.#inFlight.set(roomId, gate);
    return gate;
  }

  async #refill(room: RoomRef, seeds: readonly TrackSeed[]): Promise<void> {
    const { roomId } = room;
    return this.#gated(roomId, async () => {
      // A drifted buffer must go through a release so its reservations are
      // handed back — silently dropping it kept every discarded pick locked
      // out for the full reservation TTL, starving the pool's head. The
      // release is AWAITED (we are inside the per-guild gate): fired and
      // forgotten, the Redis DEL could land after the SET NX of the very next
      // generation pass and delete a live reservation.
      const existing = this.#buffers.get(roomId);
      const survivors =
        existing !== undefined && seedWindowOf(seeds).has(existing.seedKey) ? existing.tracks : [];
      if (existing !== undefined && survivors.length === 0) {
        this.#buffers.delete(roomId);
        if (existing.tracks.length > 0) {
          await this.#session
            .release(
              roomId,
              existing.tracks.map((entry) => entry.reservedKey),
            )
            .catch(() => undefined);
        }
      }

      // Only generate the shortfall: survivors keep their reservations and
      // their place at the front of the buffer.
      const needed = this.#options.prefetchSize - survivors.length;
      if (needed <= 0) return;

      const entries = await this.#generate(room, seeds, needed, { background: true });
      if (survivors.length + entries.length > 0) {
        this.#buffers.set(roomId, {
          tracks: [...survivors, ...entries],
          // Anchored to the ORIGINAL generation when entries survive a merge:
          // a survivor's reservation (20 min from reserve) must always outlive
          // the buffer's validity (15 min), and resetting this clock on every
          // merge would let a survivor sit past its reservation, protected by
          // nothing.
          generatedAt:
            survivors.length > 0 && existing !== undefined ? existing.generatedAt : Date.now(),
          seedKey: seedKeyOf(seeds),
        });
      }
    });
  }

  async #generate(
    room: RoomRef,
    seeds: readonly TrackSeed[],
    count: number,
    options: { readonly background: boolean },
  ): Promise<readonly BufferedTrack[]> {
    const { roomId } = room;
    // The generator reads the session itself — exclusions, reservations and
    // the familiar/discovery rhythm all live there — and returns picks that
    // are already reserved under `reservedKey`.
    const generated = await this.#generator.generate(room, seeds, count, options);

    if (generated.length > 0) {
      void this.#session
        .recordOutcome(roomId, 'recommended', generated.length)
        .catch(() => undefined);
    }

    // Quality is measured, not asserted: one structured line per generation
    // pass, so a regression shows up in the logs before it shows up in a
    // complaint.
    try {
      const snapshot = await this.#session.snapshot(roomId);
      logger.debug(
        {
          event: 'AUTOPLAY_METRICS',
          roomId,
          ...computeAutoplayMetrics(snapshot.outcomes, snapshot.recentArtists),
        },
        'Autoplay quality metrics',
      );
    } catch {
      // Metrics are observability, never a reason to fail a generation.
    }

    return generated.map((entry) => ({ track: entry.track, reservedKey: entry.reservedKey }));
  }
}

/**
 * Identity of the seed set — the newest seed's canonical key.
 *
 * A buffer built while a Punjabi track was playing is the wrong buffer once
 * the room has moved on, and comparing seed identity is how that is noticed
 * without waiting for the TTL. Exactly ONE seed participates, canonicalised:
 * the original compared two differently-sized seed lists from two call sites
 * as raw strings, which never matched — every buffer was judged stale and the
 * prefetch path silently never served.
 */
function seedKeyOf(seeds: readonly TrackSeed[]): string {
  const newest = seeds[0];
  return newest === undefined ? '' : trackKeyOf(newest.artist, newest.title);
}

/**
 * Every canonical key in the caller's seed window.
 *
 * Buffer validity is judged against the WINDOW, not just the newest seed: a
 * buffer generated while the previous track played is following this same
 * session and must not be torn down (with a full regeneration and a batch of
 * orphaned reservations) merely because one more track has started since.
 */
function seedWindowOf(seeds: readonly TrackSeed[]): ReadonlySet<string> {
  return new Set(seeds.slice(0, 4).map((seed) => trackKeyOf(seed.artist, seed.title)));
}

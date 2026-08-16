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

import { trackKeyOf } from './identity.js';
import { computeAutoplayMetrics } from './metrics.js';
import { MusicOrchestrator } from './orchestrator.js';
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
  readonly #orchestrator: MusicOrchestrator;
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

  constructor(
    orchestrator: MusicOrchestrator,
    session: AutoplaySessionStore,
    options: AutoplayOptions,
  ) {
    this.#orchestrator = orchestrator;
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
   * Serves from the buffer when it can — that path is a map lookup rather than
   * a network round trip. Falls through to generating synchronously (without
   * the LLM pass) when the buffer is empty or stale, and returns an empty
   * array rather than throwing, so the caller's own fallback can take over.
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

    // An in-flight generation is worth waiting for — it is already most of the
    // way through the work this call would otherwise redo from scratch.
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
      let served: readonly QueuedTrack[] = [];
      await this.#gated(guildId, async () => {
        served = (await this.#generate(guildId, seeds, count, { background: false })).map(
          (entry) => entry.track,
        );
      });
      logger.debug({ guildId, served: served.length, from: 'synchronous' }, 'Autoplay served');
      return served;
    } catch (error) {
      logger.warn({ err: error, guildId }, 'Autoplay generation failed');
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
  clear(guildId: string): void {
    const buffer = this.#buffers.get(guildId);
    this.#buffers.delete(guildId);
    if (buffer !== undefined && buffer.tracks.length > 0) {
      void this.#session
        .release(
          guildId,
          buffer.tracks.map((entry) => entry.reservedKey),
        )
        .catch(() => undefined);
    }
  }

  #drain(guildId: string, count: number, seeds: readonly TrackSeed[]): readonly QueuedTrack[] {
    const buffer = this.#buffers.get(guildId);
    if (buffer === undefined) return [];

    const stale =
      Date.now() - buffer.generatedAt > BUFFER_TTL_MS || buffer.seedKey !== seedKeyOf(seeds);
    if (stale) {
      this.clear(guildId);
      return [];
    }

    const taken = buffer.tracks.splice(0, count);
    if (buffer.tracks.length === 0) this.#buffers.delete(guildId);
    // Reservations on served tracks stay: the caller is about to queue them,
    // and the reservation TTL covers the gap until the queue sync sees them.
    return taken.map((entry) => entry.track);
  }

  /** Run `work` as THE generation pass for a guild; concurrent calls coalesce. */
  async #gated(guildId: string, work: () => Promise<void>): Promise<void> {
    const existing = this.#inFlight.get(guildId);
    if (existing !== undefined) return existing;

    const gate = work().finally(() => {
      this.#inFlight.delete(guildId);
    });
    this.#inFlight.set(guildId, gate);
    return gate;
  }

  async #refill(guildId: string, seeds: readonly TrackSeed[]): Promise<void> {
    return this.#gated(guildId, async () => {
      const entries = await this.#generate(guildId, seeds, this.#options.prefetchSize, {
        background: true,
      });
      if (entries.length > 0) {
        // A buffer may already exist if a take() drained part of one while
        // this refill was queued behind it; merging (rather than overwriting)
        // preserves reservations already made for the surviving entries.
        const existing = this.#buffers.get(guildId);
        const survivors = existing?.seedKey === seedKeyOf(seeds) ? existing.tracks : [];
        this.#buffers.set(guildId, {
          tracks: [...survivors, ...entries],
          generatedAt: Date.now(),
          seedKey: seedKeyOf(seeds),
        });
      }
    });
  }

  async #generate(
    guildId: string,
    seeds: readonly TrackSeed[],
    count: number,
    options: { readonly background: boolean },
  ): Promise<readonly BufferedTrack[]> {
    const snapshot = await this.#session.snapshot(guildId);

    // Everything the session knows about is a hard exclusion: playing/queued,
    // reserved by another pass, or inside the recent-play cooldown window.
    const exclusions = {
      trackKeys: new Set([
        ...snapshot.recentKeys,
        ...snapshot.queuedKeys,
        ...snapshot.reservedKeys,
      ]),
      identifiers: new Set([...snapshot.recentIdentifiers, ...snapshot.queuedIdentifiers]),
    };

    const result = await this.#orchestrator.recommend({
      guildId,
      seeds,
      count,
      // Autoplay continues a session; there is no sentence to parse, so the
      // intent is synthesised. The only LLM involvement is the optional rerank
      // pass, and only when this generation is running in the background.
      intent: MusicOrchestrator.continuationIntent(count),
      exclusions,
      session: {
        recentArtists: snapshot.recentArtists,
        artistFatigue: snapshot.artistFatigue,
      },
      allowRerank: options.background,
      reserve: (keys) => this.#session.reserve(guildId, keys),
    });

    if (result.resolved.length > 0) {
      void this.#session
        .recordOutcome(guildId, 'recommended', result.resolved.length)
        .catch(() => undefined);
    }
    if (result.blockedCount > 0) {
      void this.#session
        .recordOutcome(guildId, 'duplicatesBlocked', result.blockedCount)
        .catch(() => undefined);
    }

    // Quality is measured, not asserted: one structured line per generation
    // pass, so a regression shows up in the logs before it shows up in a
    // complaint.
    logger.debug(
      {
        event: 'AUTOPLAY_METRICS',
        guildId,
        ...computeAutoplayMetrics(snapshot.outcomes, snapshot.recentArtists),
      },
      'Autoplay quality metrics',
    );

    return result.resolved.map((entry) => ({ track: entry.track, reservedKey: entry.trackKey }));
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

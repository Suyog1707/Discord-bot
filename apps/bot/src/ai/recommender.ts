/**
 * Candidate generation, ranking, and turning the winners into playable tracks.
 *
 * The shape of this pipeline is the whole answer to "how do you queue 300 songs
 * without 300 AI calls":
 *
 *   seeds -> Last.fm (a handful of parallel calls) -> a few hundred candidates
 *         -> cheap local scoring (no I/O)
 *         -> tag enrichment for the shortlist only
 *         -> rescore, pick diversely
 *         -> bounded-concurrency Lavalink resolution
 *
 * Everything expensive is batched or bounded, and the only per-track network
 * work is the final resolution — which has to happen regardless of how the
 * tracks were chosen, because a title is not a stream.
 *
 * Tag enrichment is the step most likely to be got wrong. Tags are needed for
 * mood and language fit, but fetching them per candidate would be hundreds of
 * calls. Instead candidates are scored twice: once cheaply to find a shortlist,
 * then again with tags fetched per *artist* (far fewer, cached for a week, and
 * already warm for anyone the listener favours).
 */
import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from '../music/track.js';

import type { CacheService } from './cache.js';
import type { MusicIntent } from './intent.js';
import type { LastFmService } from './lastfm.js';
import { normaliseArtist, primaryArtist } from './musicbrainz.js';
import {
  type Candidate,
  type ScoredCandidate,
  type ScoringContext,
  dominantLanguage,
  explainScore,
  scoreCandidate,
  selectDiverse,
} from './scoring.js';
import type { RecentContext, TasteProfile } from './taste.js';

const logger = getLogger('recommender');

/** Seeds to expand from. More than this adds candidates without adding variety. */
const MAX_SEEDS = 4;
/**
 * Distinct artists whose tags are fetched for the shortlist. Caps the enrichment
 * cost independently of how many tracks were requested — a 300-track pool rarely
 * has more distinct artists than this anyway.
 */
const MAX_TAG_LOOKUPS = 60;
/** Shortlist size as a multiple of the request, so diversity has room to choose. */
const SHORTLIST_FACTOR = 3;

export interface TrackSeed {
  readonly title: string;
  readonly artist: string;
  readonly identifier?: string;
}

export interface RecommendationRequest {
  readonly seeds: readonly TrackSeed[];
  readonly count: number;
  readonly profile: TasteProfile;
  readonly recent: RecentContext;
  readonly intent?: MusicIntent;
}

/** Per-stage timings, in milliseconds. Logged at debug; never shown to users. */
export interface RecommendationTimings {
  readonly candidateMs: number;
  readonly enrichMs: number;
  readonly scoreMs: number;
  readonly resolveMs: number;
  readonly totalMs: number;
}

export interface RecommendationResult {
  readonly tracks: readonly QueuedTrack[];
  /** Ranked picks, including the score breakdown behind each one. */
  readonly picks: readonly ScoredCandidate[];
  readonly candidateCount: number;
  readonly timings: RecommendationTimings;
  /** Which generation strategies contributed, for diagnosis. */
  readonly strategies: readonly string[];
}

/**
 * Resolves a candidate to something Lavalink can play.
 *
 * Injected rather than imported so this module never depends on the player, and
 * so tests can drive the whole pipeline without a Lavalink node.
 */
export type TrackResolver = (candidate: Candidate) => Promise<QueuedTrack | null>;

/**
 * Tuning knobs, injected rather than read from the environment.
 *
 * A service that reaches for a global config singleton cannot be exercised
 * without booting the whole app's env, and these two numbers are exactly what a
 * performance test needs to vary.
 */
export interface RecommendationTuning {
  /** Candidate pool size before ranking trims it. */
  readonly poolSize: number;
  /** Simultaneous Lavalink resolutions. Keeps the streaming node responsive. */
  readonly concurrency: number;
}

export const DEFAULT_TUNING: RecommendationTuning = { poolSize: 400, concurrency: 8 };

export class RecommendationService {
  readonly #lastfm: LastFmService;
  readonly #cache: CacheService;
  readonly #tuning: RecommendationTuning;

  constructor(
    lastfm: LastFmService,
    cache: CacheService,
    tuning: RecommendationTuning = DEFAULT_TUNING,
  ) {
    this.#lastfm = lastfm;
    this.#cache = cache;
    this.#tuning = tuning;
  }

  /**
   * Produce up to `count` playable tracks.
   *
   * Returns fewer rather than failing when the pool is thin — a short queue is a
   * worse outcome than a full one, but it is a far better outcome than an error.
   */
  async recommend(
    request: RecommendationRequest,
    resolve: TrackResolver,
  ): Promise<RecommendationResult> {
    const startedAt = Date.now();

    const candidateStart = Date.now();
    const { candidates, strategies } = await this.#generateCandidates(request);
    const candidateMs = Date.now() - candidateStart;

    if (candidates.length === 0) {
      return {
        tracks: [],
        picks: [],
        candidateCount: 0,
        strategies,
        timings: {
          candidateMs,
          enrichMs: 0,
          scoreMs: 0,
          resolveMs: 0,
          totalMs: Date.now() - startedAt,
        },
      };
    }

    const context = this.#scoringContext(request);

    // Pass one: no tags, no I/O. Cheap enough to run over the whole pool.
    const scoreStart = Date.now();
    const roughlyRanked = candidates
      .map((candidate) => scoreCandidate(candidate, context))
      .sort((a, b) => b.breakdown.final - a.breakdown.final);
    const shortlist = roughlyRanked.slice(0, request.count * SHORTLIST_FACTOR);
    const scoreMs = Date.now() - scoreStart;

    // Pass two: tags for the shortlist's artists only.
    const enrichStart = Date.now();
    const tagged = await this.#enrichWithTags(shortlist.map((entry) => entry.candidate));
    const enrichMs = Date.now() - enrichStart;

    const finalRanked = tagged.map((candidate) => scoreCandidate(candidate, context));
    const picks = selectDiverse(finalRanked, request.count, {
      enforceArtistDiversity: request.intent?.artistDiversity ?? true,
    });

    const resolveStart = Date.now();
    const tracks = await this.#resolveAll(picks, resolve);
    const resolveMs = Date.now() - resolveStart;

    const timings: RecommendationTimings = {
      candidateMs,
      enrichMs,
      scoreMs,
      resolveMs,
      totalMs: Date.now() - startedAt,
    };

    logger.debug(
      {
        requested: request.count,
        candidates: candidates.length,
        picked: picks.length,
        resolved: tracks.length,
        strategies,
        ...timings,
      },
      'Recommendation complete',
    );

    // The audit trail for "why was this song recommended?". Trace level because
    // it is one line per track and would drown a production log.
    if (logger.isLevelEnabled('trace')) {
      for (const pick of picks.slice(0, 10)) {
        logger.trace(
          { track: `${pick.candidate.artist} — ${pick.candidate.title}` },
          explainScore(pick),
        );
      }
    }

    return { tracks, picks, candidateCount: candidates.length, timings, strategies };
  }

  #scoringContext(request: RecommendationRequest): ScoringContext {
    const intent = request.intent;
    const desiredTags = [...(intent?.mood ?? []), ...(intent?.genre ?? [])].map((tag) =>
      tag.toLowerCase(),
    );

    return {
      profile: request.profile,
      recent: request.recent,
      ...(desiredTags.length === 0 ? {} : { desiredTags }),
      // An explicitly requested language always wins; otherwise fall back to
      // whatever the listener has established, which is what keeps a Hindi
      // session Hindi without anyone having to ask for it.
      desiredLanguage: intent?.language ?? dominantLanguage(request.profile),
      excludedArtists: (intent?.excludeArtists ?? []).map((artist) =>
        normaliseArtist(primaryArtist(artist)),
      ),
      ...(intent === undefined ? {} : { avoidRecent: intent.avoidRecent }),
    };
  }

  /**
   * Build the candidate pool.
   *
   * Every source runs concurrently — they are independent lookups against a
   * cache-fronted API, and running them in series would make the pool the
   * slowest part of the pipeline for no reason.
   */
  async #generateCandidates(request: RecommendationRequest): Promise<{
    candidates: readonly Candidate[];
    strategies: readonly string[];
  }> {
    const poolLimit = this.#tuning.poolSize;
    const seeds = request.seeds.slice(0, MAX_SEEDS);
    const intent = request.intent;
    const strategies: string[] = [];

    if (!this.#lastfm.enabled) {
      // No discovery source. The caller's own fallback (YouTube mixes) takes
      // over — this is not an error, just a thinner pipeline.
      return { candidates: [], strategies: ['lastfm-disabled'] };
    }

    const tasks: Promise<readonly Candidate[]>[] = [];

    // Similar tracks: the strongest signal, one call per seed.
    for (const seed of seeds) {
      tasks.push(
        this.#lastfm
          .similarTracks(seed.artist, seed.title, 60)
          .then((tracks) =>
            tracks.map((track): Candidate => ({
              title: track.name,
              artist: track.artist,
              origin: 'similar-track',
              match: track.match,
            })),
          )
          .catch(() => []),
      );
    }
    if (seeds.length > 0) strategies.push('similar-tracks');

    // Similar artists widen a pool that similar-tracks left thin — a niche seed
    // can return almost nothing, and its neighbours' catalogues will not.
    for (const seed of seeds.slice(0, 2)) {
      tasks.push(
        this.#lastfm
          .similarArtists(seed.artist, 15)
          .then(async (artists) => {
            const perArtist = await Promise.all(
              artists.slice(0, 6).map(async (artist) => {
                const tracks = await this.#lastfm
                  .similarTracks(artist.name, seed.title, 10)
                  .catch(() => []);
                return tracks.map((track): Candidate => ({
                  title: track.name,
                  artist: track.artist,
                  origin: 'similar-artist',
                  // Discount by how close the artist itself is to the seed.
                  match: track.match * artist.match,
                }));
              }),
            );
            return perArtist.flat();
          })
          .catch(() => []),
      );
    }
    if (seeds.length > 0) strategies.push('similar-artists');

    // Tag charts turn a mood or genre from the request into real songs, without
    // the model ever naming one.
    const requestedTags = [...(intent?.mood ?? []), ...(intent?.genre ?? [])];
    const languageTag = intent?.language;
    const tagQueries = [
      ...new Set([
        ...requestedTags,
        ...(languageTag === null || languageTag === undefined ? [] : [languageTag]),
      ]),
    ];

    for (const tag of tagQueries.slice(0, 4)) {
      tasks.push(
        this.#lastfm
          .tagTopTracks(tag, 60)
          .then((tracks) =>
            tracks.map((track): Candidate => ({
              title: track.name,
              artist: track.artist,
              origin: 'tag-chart',
              match: track.match,
              // A tag chart's own tag is a fact about every track on it.
              tags: [tag.toLowerCase()],
            })),
          )
          .catch(() => []),
      );
    }
    if (tagQueries.length > 0) strategies.push('tag-charts');

    const groups = await Promise.all(tasks);

    // Dedupe by normalised artist+title, keeping the strongest evidence for each
    // track: the same song arriving from three sources should be scored on its
    // best claim, not its last.
    const byKey = new Map<string, Candidate>();
    for (const group of groups) {
      for (const candidate of group) {
        const key = `${normaliseArtist(primaryArtist(candidate.artist))}::${candidate.title.toLowerCase()}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, candidate);
          continue;
        }
        if (candidate.match > existing.match) {
          byKey.set(key, {
            ...candidate,
            tags: [...new Set([...(existing.tags ?? []), ...(candidate.tags ?? [])])],
          });
        } else if ((candidate.tags ?? []).length > 0) {
          byKey.set(key, {
            ...existing,
            tags: [...new Set([...(existing.tags ?? []), ...(candidate.tags ?? [])])],
          });
        }
      }
    }

    // Drop anything the request explicitly excluded before it can cost a lookup.
    const excluded = new Set(
      (intent?.excludeArtists ?? []).map((artist) => normaliseArtist(primaryArtist(artist))),
    );
    const candidates = [...byKey.values()]
      .filter((candidate) => !excluded.has(normaliseArtist(primaryArtist(candidate.artist))))
      .slice(0, poolLimit);

    return { candidates, strategies };
  }

  /**
   * Attach artist tags to the shortlist.
   *
   * Per artist rather than per track, capped, and cached for a week — the
   * difference between a handful of lookups and several hundred.
   */
  async #enrichWithTags(candidates: readonly Candidate[]): Promise<readonly Candidate[]> {
    if (!this.#lastfm.enabled) return candidates;

    const artists = [
      ...new Set(candidates.map((candidate) => primaryArtist(candidate.artist))),
    ].slice(0, MAX_TAG_LOOKUPS);

    const tagsByArtist = new Map<string, readonly string[]>();
    await Promise.all(
      artists.map(async (artist) => {
        const key = normaliseArtist(artist);
        const cached = await this.#cache.get<readonly string[]>(`artist-tags:${key}`);
        if (cached !== null) {
          tagsByArtist.set(key, cached);
          return;
        }
        const tags = (await this.#lastfm.artistTags(artist).catch(() => []))
          .slice(0, 8)
          .map((tag) => tag.name);
        tagsByArtist.set(key, tags);
        await this.#cache.set(`artist-tags:${key}`, tags, 7 * 24 * 60 * 60_000);
      }),
    );

    return candidates.map((candidate) => {
      const artistTags = tagsByArtist.get(normaliseArtist(primaryArtist(candidate.artist))) ?? [];
      if (artistTags.length === 0) return candidate;
      return { ...candidate, tags: [...new Set([...(candidate.tags ?? []), ...artistTags])] };
    });
  }

  /**
   * Resolve picks to playable tracks with bounded parallelism.
   *
   * The bound is the point: three hundred simultaneous searches would bury the
   * Lavalink node that is also streaming audio, and an unbounded `Promise.all`
   * over a long playlist is exactly how a queue request takes the player down
   * with it. Batches keep the node responsive while still being an order of
   * magnitude faster than resolving one at a time.
   */
  async #resolveAll(
    picks: readonly ScoredCandidate[],
    resolve: TrackResolver,
  ): Promise<readonly QueuedTrack[]> {
    const batchSize = Math.max(1, this.#tuning.concurrency);
    const resolved: QueuedTrack[] = [];
    const seen = new Set<string>();

    for (let offset = 0; offset < picks.length; offset += batchSize) {
      const batch = picks.slice(offset, offset + batchSize);
      const results = await Promise.all(
        batch.map(async (pick) => {
          try {
            return await resolve(pick.candidate);
          } catch (error) {
            // One unresolvable candidate must never sink the batch.
            logger.debug(
              { err: error, track: `${pick.candidate.artist} — ${pick.candidate.title}` },
              'Candidate resolution failed',
            );
            return null;
          }
        }),
      );

      for (const track of results) {
        // Two candidates can resolve to the same upload; the queue should not
        // hold it twice just because Last.fm listed it under two names.
        if (track === null || seen.has(track.identifier)) continue;
        seen.add(track.identifier);
        resolved.push(track);
      }
    }

    return resolved;
  }
}

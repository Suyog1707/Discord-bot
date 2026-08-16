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
import { identityOf, trackKeyOf } from './identity.js';
import type { MusicIntent } from './intent.js';
import type { LastFmService } from './lastfm.js';
import { normaliseArtist, primaryArtist } from './musicbrainz.js';
import type { RerankContext, ShortlistReranker } from './rerank.js';
import {
  type Candidate,
  type ScoredCandidate,
  type ScoringContext,
  dominantLanguage,
  explainScore,
  scoreCandidate,
  selectDiverse,
  selectSequence,
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
/** Shortlist floor: a 5-track autoplay batch still deserves a real choice. */
const MIN_SHORTLIST = 40;
/**
 * Ceiling on how much the LLM's opinion can move a score. Enough to reorder
 * near-ties, never enough to overturn the deterministic ranking outright.
 */
const RERANK_BONUS = 0.08;

export interface TrackSeed {
  readonly title: string;
  readonly artist: string;
  readonly identifier?: string;
}

/**
 * The hard exclusion layer. Anything here is REMOVED from the pipeline — never
 * merely down-scored. A recently played song with a brilliant score is still a
 * recently played song, and letting scoring arbitrate that is exactly how the
 * repeated-song bug survived: the rule must be structural, not statistical.
 */
export interface RecommendationExclusions {
  /** Canonical track keys: playing now, queued, reserved, recently played. */
  readonly trackKeys: ReadonlySet<string>;
  /** Provider identifiers for the same set, catching cross-vocabulary slips. */
  readonly identifiers: ReadonlySet<string>;
}

const EMPTY_EXCLUSIONS: RecommendationExclusions = {
  trackKeys: new Set<string>(),
  identifiers: new Set<string>(),
};

/** Live session signals, distinct from the long-term profile. */
export interface SessionContext {
  /** Artist keys played this session, newest first. */
  readonly recentArtists: readonly string[];
  /** Adaptive per-artist fatigue, 0..1. */
  readonly artistFatigue: ReadonlyMap<string, number>;
}

export interface RecommendationRequest {
  readonly seeds: readonly TrackSeed[];
  readonly count: number;
  readonly profile: TasteProfile;
  readonly recent: RecentContext;
  readonly intent?: MusicIntent;
  readonly exclusions?: RecommendationExclusions;
  readonly session?: SessionContext;
  /**
   * Loved-and-rested songs from play history (the `history` origin). Supplied
   * by the caller because history lives behind the taste service, not here.
   */
  readonly historyCandidates?: readonly {
    readonly title: string;
    readonly artist: string;
    readonly identifier: string;
  }[];
  /**
   * Allow one LLM rerank pass over the shortlist. Only the background prefetch
   * path sets this — the synchronous playback path must never wait on a model.
   */
  readonly allowRerank?: boolean;
  /**
   * Atomically reserve selected candidates before resolution. Returns the keys
   * this caller won; picks that lost the race are dropped, which is what stops
   * two concurrent generation passes queueing the same song.
   */
  readonly reserve?: (keys: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * Hand back reservations for picks that did not survive resolution (search
   * failed, implausible match, post-resolution duplicate). Without this every
   * failed pick keeps its song locked out for the full reservation TTL, and a
   * source that resolves poorly slowly starves the candidate pool's head.
   */
  readonly release?: (keys: readonly string[]) => Promise<void>;
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
  /** Each resolved track paired with the candidate key it was reserved under. */
  readonly resolved: readonly { readonly track: QueuedTrack; readonly trackKey: string }[];
  /** Ranked picks, including the score breakdown behind each one. */
  readonly picks: readonly ScoredCandidate[];
  readonly candidateCount: number;
  /** Candidates removed by the hard exclusion layer before ranking. */
  readonly excludedCount: number;
  /**
   * Duplicates caught AFTER resolution — picks whose resolved upload turned
   * out to be something already playing, queued or recently played. This is
   * the near-miss counter behind duplicate_recommendation_rate.
   */
  readonly blockedCount: number;
  /** Whether the LLM reranker actually contributed to the ordering. */
  readonly reranked: boolean;
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
  readonly #reranker: ShortlistReranker | undefined;

  constructor(
    lastfm: LastFmService,
    cache: CacheService,
    tuning: RecommendationTuning = DEFAULT_TUNING,
    reranker?: ShortlistReranker,
  ) {
    this.#lastfm = lastfm;
    this.#cache = cache;
    this.#tuning = tuning;
    this.#reranker = reranker;
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
    const exclusions = request.exclusions ?? EMPTY_EXCLUSIONS;
    logger.debug(
      {
        event: 'AUTOPLAY_RECOMMENDATION_STARTED',
        requested: request.count,
        excludedKeys: exclusions.trackKeys.size,
      },
      'Recommendation started',
    );

    const candidateStart = Date.now();
    const { candidates, strategies, excludedCount } = await this.#generateCandidates(
      request,
      exclusions,
    );
    const candidateMs = Date.now() - candidateStart;

    if (candidates.length === 0) {
      return {
        tracks: [],
        resolved: [],
        picks: [],
        candidateCount: 0,
        excludedCount,
        blockedCount: 0,
        reranked: false,
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
    // A floor on the shortlist keeps small requests from starving the
    // diversity and rerank stages of choice.
    const shortlist = roughlyRanked.slice(
      0,
      Math.max(request.count * SHORTLIST_FACTOR, MIN_SHORTLIST),
    );
    const scoreMs = Date.now() - scoreStart;

    // Pass two: tags for the shortlist's artists only.
    const enrichStart = Date.now();
    const tagged = await this.#enrichWithTags(shortlist.map((entry) => entry.candidate));
    const enrichMs = Date.now() - enrichStart;

    let finalRanked = tagged
      .map((candidate) => scoreCandidate(candidate, context))
      .sort((a, b) => b.breakdown.final - a.breakdown.final);

    // Optional LLM pass. It sees an already-filtered list and returns indices,
    // so it can suggest ordering but structurally cannot introduce a song. Its
    // opinion lands as a bounded bonus, not a veto over the deterministic
    // scores — and any failure leaves the ranking exactly as it was.
    let reranked = false;
    if (request.allowRerank === true && this.#reranker !== undefined) {
      const permutation = await this.#reranker.rerank(
        finalRanked.map((entry) => ({
          title: entry.candidate.title,
          artist: entry.candidate.artist,
          score: entry.breakdown.final,
          ...(entry.candidate.tags === undefined ? {} : { tags: entry.candidate.tags }),
        })),
        this.#rerankContext(request),
      );
      if (permutation !== null) {
        reranked = true;
        const bonusFor = new Map<number, number>();
        permutation.forEach((originalIndex, rank) => {
          bonusFor.set(originalIndex, RERANK_BONUS * (1 - rank / permutation.length));
        });
        finalRanked = finalRanked.map((entry, index) => {
          const bonus = bonusFor.get(index) ?? 0;
          return bonus === 0
            ? entry
            : {
                ...entry,
                breakdown: {
                  ...entry.breakdown,
                  final: Math.min(1, entry.breakdown.final + bonus),
                },
              };
        });
      }
    }

    // Session requests get the sequence-aware selector; one-shot requests
    // (/ask playlists) keep the simpler per-batch diversity cap.
    const session = request.session;
    const picks =
      session === undefined
        ? selectDiverse(finalRanked, request.count, {
            enforceArtistDiversity: request.intent?.artistDiversity ?? true,
          })
        : selectSequence(finalRanked, request.count, {
            artistFatigue: session.artistFatigue,
            knownArtists: new Set(Object.keys(request.profile.artistAffinity)),
          });

    // Reserve before resolving: a pick that loses the race to a concurrent
    // generation pass is dropped here, never resolved, never queued twice.
    let reservedPicks = picks;
    if (request.reserve !== undefined && picks.length > 0) {
      const granted = await request.reserve(picks.map((pick) => pick.trackKey));
      reservedPicks = picks.filter((pick) => granted.has(pick.trackKey));
      if (reservedPicks.length < picks.length) {
        logger.debug(
          {
            event: 'RECOMMENDATION_RESERVED',
            requested: picks.length,
            granted: reservedPicks.length,
          },
          'Reservation dropped contested picks',
        );
      }
    }

    const resolveStart = Date.now();
    const { resolved, blocked } = await this.#resolveAll(reservedPicks, resolve, exclusions);
    const resolveMs = Date.now() - resolveStart;

    // Reservations for picks that did not become tracks go back immediately.
    if (request.release !== undefined) {
      const kept = new Set(resolved.map((entry) => entry.trackKey));
      const unused = reservedPicks
        .map((pick) => pick.trackKey)
        .filter((key) => !kept.has(key));
      if (unused.length > 0) await request.release(unused).catch(() => undefined);
    }

    const timings: RecommendationTimings = {
      candidateMs,
      enrichMs,
      scoreMs,
      resolveMs,
      totalMs: Date.now() - startedAt,
    };

    logger.debug(
      {
        event: 'CANDIDATES_FILTERED',
        requested: request.count,
        candidates: candidates.length,
        excluded: excludedCount + blocked,
        picked: reservedPicks.length,
        resolved: resolved.length,
        reranked,
        strategies,
        ...timings,
      },
      'Recommendation complete',
    );

    // The audit trail for "why was this song recommended?". Trace level because
    // it is one line per track and would drown a production log.
    if (logger.isLevelEnabled('trace')) {
      for (const pick of reservedPicks.slice(0, 10)) {
        logger.trace(
          { track: `${pick.candidate.artist} — ${pick.candidate.title}` },
          explainScore(pick),
        );
      }
    }

    return {
      tracks: resolved.map((entry) => entry.track),
      resolved,
      picks: reservedPicks,
      candidateCount: candidates.length,
      excludedCount,
      blockedCount: blocked,
      reranked,
      timings,
      strategies,
    };
  }

  #rerankContext(request: RecommendationRequest): RerankContext {
    const topOf = (record: Readonly<Record<string, number>>, take: number): string[] =>
      Object.entries(record)
        .filter(([, value]) => value > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, take)
        .map(([name]) => name);

    return {
      topArtists: topOf(request.profile.artistAffinity, 5),
      topTags: topOf(request.profile.tagAffinity, 5),
      recentTitles: request.recent.titles.slice(0, 6),
      discoveryLevel: 0.15,
    };
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
      ...(request.session === undefined
        ? {}
        : { artistFatigue: request.session.artistFatigue }),
    };
  }

  /**
   * Build the candidate pool.
   *
   * Every source runs concurrently — they are independent lookups against a
   * cache-fronted API, and running them in series would make the pool the
   * slowest part of the pipeline for no reason.
   */
  async #generateCandidates(
    request: RecommendationRequest,
    exclusions: RecommendationExclusions,
  ): Promise<{
    candidates: readonly Candidate[];
    strategies: readonly string[];
    excludedCount: number;
  }> {
    const poolLimit = this.#tuning.poolSize;
    const seeds = request.seeds.slice(0, MAX_SEEDS);
    const intent = request.intent;
    const strategies: string[] = [];

    // Loved-and-rested history joins the pool directly — no lookup needed, the
    // caller already vetted completion and cooldown. It is also the one source
    // that works with no Last.fm key at all.
    const historyGroup: readonly Candidate[] = (request.historyCandidates ?? []).map(
      (song): Candidate => ({
        title: song.title,
        artist: song.artist,
        origin: 'history',
        match: 0.5,
        identifier: song.identifier,
      }),
    );
    if (historyGroup.length > 0) strategies.push('history');

    if (!this.#lastfm.enabled) {
      strategies.push('lastfm-disabled');
      if (historyGroup.length === 0) {
        // No discovery source and no resurfaceable history. The caller's own
        // fallback (YouTube mixes) takes over — this is not an error, just a
        // thinner pipeline.
        return { candidates: [], strategies, excludedCount: 0 };
      }
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

    // The taste profile as a candidate SOURCE, not just a re-ranker. Without
    // this the pool is pure current-song similarity, and autoplay orbits
    // whatever happens to be playing instead of the person listening. Sorted
    // by affinity so it is the listener's actual favourites that expand.
    const profileArtists = Object.entries(request.profile.artistAffinity)
      .filter(([, affinity]) => affinity > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([artist]) => artist);

    for (const artist of profileArtists.slice(0, 6)) {
      tasks.push(
        this.#lastfm
          .artistTopTracks(artist, 12)
          .then((tracks) =>
            tracks.map(
              (track): Candidate => ({
                title: track.name,
                artist: track.artist,
                origin: 'taste-artist',
                match: track.match,
              }),
            ),
          )
          .catch(() => []),
      );
    }
    if (profileArtists.length > 0) strategies.push('taste-artists');

    // Discovery: neighbours of favourites the listener has never played.
    // Semantic taste neighbourhood, not randomness — Frank Ocean for a Weeknd
    // listener, never a random classical track.
    const knownArtists = new Set(Object.keys(request.profile.artistAffinity));
    for (const artist of profileArtists.slice(0, 2)) {
      tasks.push(
        this.#lastfm
          .similarArtists(artist, 12)
          .then(async (similar) => {
            const fresh = similar
              .filter((neighbour) => !knownArtists.has(normaliseArtist(neighbour.name)))
              .slice(0, 4);
            const perArtist = await Promise.all(
              fresh.map(async (neighbour) => {
                const tracks = await this.#lastfm
                  .artistTopTracks(neighbour.name, 6)
                  .catch(() => []);
                return tracks.map(
                  (track): Candidate => ({
                    title: track.name,
                    artist: track.artist,
                    origin: 'discovery',
                    match: track.match * neighbour.match,
                  }),
                );
              }),
            );
            return perArtist.flat();
          })
          .catch(() => []),
      );
    }
    if (profileArtists.length > 0) strategies.push('discovery');

    // Tag charts turn a mood or genre from the request into real songs, without
    // the model ever naming one. When the request carries no tags (autoplay's
    // continuation intent never does), the profile's own top tags anchor the
    // pool to the listener's genres instead of contributing nothing.
    const requestedTags = [...(intent?.mood ?? []), ...(intent?.genre ?? [])];
    const profileTags =
      requestedTags.length > 0
        ? []
        : Object.entries(request.profile.tagAffinity)
            .filter(([, affinity]) => affinity > 0)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 2)
            .map(([tag]) => tag);
    const languageTag = intent?.language;
    const tagQueries = [
      ...new Set([
        ...requestedTags,
        ...profileTags,
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

    // Seeds must never recommend themselves: the pool is largely built FROM
    // them, and "the song that is playing right now" is the most jarring
    // repeat of all.
    const seedKeys = new Set(seeds.map((seed) => trackKeyOf(seed.artist, seed.title)));

    // Dedupe on the CANONICAL key — the same identity used by scoring, history
    // and the session store. Using a different key here (raw lowercase titles,
    // as this once did) let "Song" and "Song (Official Video)" survive as two
    // candidates that resolved to the same upload. Hard exclusions apply in
    // the same pass: excluded songs are REMOVED, never merely down-scored.
    let excludedCount = 0;
    const byKey = new Map<string, Candidate>();
    for (const group of [...groups, historyGroup]) {
      for (const candidate of group) {
        const key = trackKeyOf(candidate.artist, candidate.title);
        if (
          exclusions.trackKeys.has(key) ||
          seedKeys.has(key) ||
          (candidate.identifier !== undefined && exclusions.identifiers.has(candidate.identifier))
        ) {
          excludedCount += 1;
          continue;
        }
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

    logger.debug(
      {
        event: 'CANDIDATES_GENERATED',
        pool: candidates.length,
        excluded: excludedCount,
        strategies,
      },
      'Candidate pool built',
    );
    return { candidates, strategies, excludedCount };
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
    exclusions: RecommendationExclusions,
  ): Promise<{
    resolved: readonly { readonly track: QueuedTrack; readonly trackKey: string }[];
    blocked: number;
  }> {
    const batchSize = Math.max(1, this.#tuning.concurrency);
    const resolved: { track: QueuedTrack; trackKey: string }[] = [];
    const seenIdentifiers = new Set<string>();
    const seenKeys = new Set<string>();
    let blocked = 0;

    for (let offset = 0; offset < picks.length; offset += batchSize) {
      const batch = picks.slice(offset, offset + batchSize);
      const results = await Promise.all(
        batch.map(async (pick) => {
          try {
            const track = await resolve(pick.candidate);
            return track === null ? null : { track, pick };
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

      for (const entry of results) {
        if (entry === null) continue;
        const { track, pick } = entry;
        // The resolved upload has its own vocabulary ("Song (Official Video)"
        // by "Artist - Topic"), so its identity is checked AGAIN here: two
        // different candidates can resolve to the same video, and a resolved
        // track can turn out to be something the queue or history already
        // holds even though the candidate key looked fresh.
        const resolvedKey = identityOf(track.author, track.title).key;
        if (
          seenIdentifiers.has(track.identifier) ||
          seenKeys.has(resolvedKey) ||
          seenKeys.has(pick.trackKey) ||
          exclusions.identifiers.has(track.identifier) ||
          exclusions.trackKeys.has(resolvedKey)
        ) {
          blocked += 1;
          logger.debug(
            {
              event: 'CANDIDATE_EXCLUDED',
              track: `${track.author} — ${track.title}`,
              identifier: track.identifier,
            },
            'Post-resolution duplicate blocked',
          );
          continue;
        }
        seenIdentifiers.add(track.identifier);
        seenKeys.add(resolvedKey);
        seenKeys.add(pick.trackKey);
        // Stamp the candidate's canonical key onto the track: downstream
        // session state must know this upload under BOTH vocabularies.
        resolved.push({ track: { ...track, sourceKey: pick.trackKey }, trackKey: pick.trackKey });
      }
    }

    return { resolved, blocked };
  }
}

/**
 * The coordination layer.
 *
 * This is the box the architecture diagram calls the orchestrator: it owns the
 * flow of a request and nothing else. Every capability behind it — intent
 * parsing, taste, discovery, metadata, ranking, caching — is a service it holds
 * an interface to, so any one of them can be swapped or removed without the flow
 * changing shape.
 *
 * Two rules govern the routing, and they are what keep the bot fast:
 *
 * Cheap requests must not take the expensive path. A plain `/play <song>` never
 * touches an LLM, Last.fm or the scoring engine — it goes straight to the
 * existing resolver, exactly as it did before any of this existed. Only a
 * request that genuinely needs recommendation pays for one.
 *
 * Nothing here is load-bearing for playback. Every stage degrades on its own:
 * no LLM falls back to keyword parsing, no Last.fm falls back to YouTube mixes,
 * no database falls back to an empty profile. The failure mode of this entire
 * module is "the music is less well chosen", never "the music stopped".
 */
import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from '../music/track.js';

import type { CacheService } from './cache.js';
import { type IntentService, type MusicIntent, musicIntentSchema } from './intent.js';
import type { LastFmService } from './lastfm.js';
import type { MusicBrainzService } from './musicbrainz.js';
import type {
  RecommendationExclusions,
  RecommendationService,
  SessionContext,
  TrackResolver,
  TrackSeed,
} from './recommender.js';
import type { AutoplaySessionStore } from './session.js';
import type { UserTasteService } from './taste.js';

const logger = getLogger('orchestrator');

/** A request from a user, in their own words. */
export interface AskRequest {
  readonly guildId: string;
  /** Discord user id, for personalisation. Absent falls back to guild taste. */
  readonly userId?: string;
  readonly text: string;
  /** Recent tracks to seed from — usually what is playing plus the last few. */
  readonly seeds: readonly TrackSeed[];
}

export interface AskOutcome {
  readonly intent: MusicIntent;
  /** Set when the request resolved to a plain lookup rather than a recommendation. */
  readonly directQuery: string | null;
  readonly tracks: readonly QueuedTrack[];
  readonly timings: Readonly<Record<string, number>>;
  readonly strategies: readonly string[];
}

export interface OrchestratorServices {
  readonly intent: IntentService;
  readonly taste: UserTasteService;
  readonly recommender: RecommendationService;
  readonly lastfm: LastFmService;
  readonly musicbrainz: MusicBrainzService;
  readonly cache: CacheService;
  /**
   * When present, EVERY recommendation path — `/ask` included — runs under the
   * session's exclusions and reservations. Without this, `/ask` raced the
   * autoplay refill for the same guild and the two could select the same song:
   * the anti-duplicate guarantees only hold if no path bypasses them.
   */
  readonly session?: AutoplaySessionStore;
}

export class MusicOrchestrator {
  readonly #services: OrchestratorServices;

  constructor(services: OrchestratorServices) {
    this.#services = services;
  }

  /** Read-only view of the wired services, for diagnostics and `/aistatus`. */
  get services(): OrchestratorServices {
    return this.#services;
  }

  /**
   * Handle a natural-language request end to end.
   *
   * The LLM runs once, at the top, and then never again — everything after it is
   * local ranking over a batched candidate pool.
   */
  async ask(request: AskRequest, resolve: TrackResolver): Promise<AskOutcome> {
    const startedAt = Date.now();

    const parsed = await this.#services.intent.parse(request.text);
    const intent = parsed.intent;

    // A named track is a lookup, not a recommendation. Handing it to the
    // ranking engine would be slower and worse: the user already told us the
    // answer.
    if (intent.intent === 'play_specific' && intent.query !== null) {
      return {
        intent,
        directQuery: intent.query,
        tracks: [],
        strategies: ['direct'],
        timings: { intentMs: parsed.latencyMs, totalMs: Date.now() - startedAt },
      };
    }

    // An unrecognised request with no mood, genre or language to work from is
    // most likely a search string the parser could not classify. Treat it as one
    // rather than generating a playlist nobody asked for.
    if (
      intent.intent === 'unknown' &&
      intent.mood.length === 0 &&
      intent.genre.length === 0 &&
      intent.language === null
    ) {
      return {
        intent,
        directQuery: intent.query ?? request.text,
        tracks: [],
        strategies: ['direct-fallback'],
        timings: { intentMs: parsed.latencyMs, totalMs: Date.now() - startedAt },
      };
    }

    const result = await this.recommend(
      {
        guildId: request.guildId,
        ...(request.userId === undefined ? {} : { userId: request.userId }),
        seeds: request.seeds,
        count: intent.quantity,
        intent,
      },
      resolve,
    );

    return {
      intent,
      directQuery: null,
      tracks: result.tracks,
      strategies: result.strategies,
      timings: {
        intentMs: parsed.latencyMs,
        ...result.timings,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Recommend without a sentence to parse.
   *
   * This is the autoplay entry point: there is no user text, only a listening
   * session to continue, so the intent is synthesised rather than parsed and no
   * LLM is involved at all.
   */
  async recommend(
    request: {
      readonly guildId: string;
      readonly userId?: string;
      readonly seeds: readonly TrackSeed[];
      readonly count: number;
      readonly intent?: MusicIntent;
      /** Hard exclusions — playing, queued, reserved, recent. See recommender. */
      readonly exclusions?: RecommendationExclusions;
      /** Live session signals (fatigue, recent artists). */
      readonly session?: SessionContext;
      /** Allow the background LLM rerank pass. */
      readonly allowRerank?: boolean;
      /** Atomic reservation hook, from the session store. */
      readonly reserve?: (keys: readonly string[]) => Promise<ReadonlySet<string>>;
      /** Reservation give-back for picks that failed to resolve. */
      readonly release?: (keys: readonly string[]) => Promise<void>;
    },
    resolve?: TrackResolver,
  ): Promise<{
    readonly tracks: readonly QueuedTrack[];
    readonly resolved: readonly { readonly track: QueuedTrack; readonly trackKey: string }[];
    readonly blockedCount: number;
    readonly timings: Readonly<Record<string, number>>;
    readonly strategies: readonly string[];
  }> {
    const resolver = resolve ?? this.#resolver;
    if (resolver === undefined) {
      throw new Error('No track resolver is available to the orchestrator.');
    }

    // Callers that did not bring their own session context (the /ask path)
    // get it from the store here, so no recommendation path can bypass the
    // exclusion and reservation guarantees. The autoplay engine passes its
    // own, built from the same snapshot it also needs for metrics.
    let exclusions = request.exclusions;
    let sessionContext = request.session;
    let reserve = request.reserve;
    let release = request.release;
    const store = this.#services.session;
    if (store !== undefined && (exclusions === undefined || reserve === undefined)) {
      try {
        const snap = await store.snapshot(request.guildId);
        exclusions ??= {
          trackKeys: new Set([...snap.recentKeys, ...snap.queuedKeys, ...snap.reservedKeys]),
          identifiers: new Set([...snap.recentIdentifiers, ...snap.queuedIdentifiers]),
        };
        sessionContext ??= {
          recentArtists: snap.recentArtists,
          artistFatigue: snap.artistFatigue,
        };
        reserve ??= (keys) => store.reserve(request.guildId, keys);
        release ??= (keys) => store.release(request.guildId, keys);
      } catch {
        // A failing store must not take recommendations down with it.
      }
    }

    const profileStart = Date.now();
    // The guild profile is what a room listens to; a personal profile only
    // applies when one user asked for something for themselves.
    const [profile, recent, favourites] = await Promise.all([
      this.#services.taste.profile(
        request.userId === undefined ? { guildId: request.guildId } : { userId: request.userId },
      ),
      this.#services.taste.recentContext(request.guildId),
      this.#services.taste.favouriteTracks(request.guildId),
    ]);
    const profileMs = Date.now() - profileStart;

    const result = await this.#services.recommender.recommend(
      {
        seeds: request.seeds,
        count: request.count,
        profile,
        recent,
        ...(request.intent === undefined ? {} : { intent: request.intent }),
        ...(favourites.length === 0 ? {} : { historyCandidates: favourites }),
        ...(exclusions === undefined ? {} : { exclusions }),
        ...(sessionContext === undefined ? {} : { session: sessionContext }),
        ...(request.allowRerank === undefined ? {} : { allowRerank: request.allowRerank }),
        ...(reserve === undefined ? {} : { reserve }),
        ...(release === undefined ? {} : { release }),
      },
      resolver,
    );

    return {
      tracks: result.tracks,
      resolved: result.resolved,
      blockedCount: result.blockedCount,
      strategies: result.strategies,
      timings: { profileMs, ...result.timings },
    };
  }

  /**
   * Default resolver, set once by the music engine at wire-up.
   *
   * Optional so the orchestrator can be constructed and unit-tested before any
   * Lavalink node exists.
   */
  #resolver: TrackResolver | undefined;

  setResolver(resolver: TrackResolver): void {
    this.#resolver = resolver;
  }

  /** Synthesise the intent autoplay implies, with no LLM call. */
  static continuationIntent(count: number): MusicIntent {
    return musicIntentSchema.parse({
      intent: 'continue_taste',
      quantity: count,
      usePersonalHistory: true,
      artistDiversity: true,
    });
  }

  /** One-line health summary for logs and a status command. */
  describe(): Record<string, boolean | number> {
    return {
      lastfm: this.#services.lastfm.enabled,
      musicbrainz: this.#services.musicbrainz.enabled,
      cacheHits: this.#services.cache.stats.hits,
      cacheMisses: this.#services.cache.stats.misses,
      redisErrors: this.#services.cache.stats.redisErrors,
    };
  }
}

/** Log a completed request's stage timings in one structured line. */
export function logTimings(
  scope: string,
  timings: Readonly<Record<string, number>>,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  logger.debug({ scope, ...timings, ...extra }, 'Pipeline timings');
}

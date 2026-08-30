/**
 * Assembly of the recommendation stack.
 *
 * One place that knows how the services fit together, so nothing else has to.
 * Everything is optional: with no keys configured this still returns a working
 * stack whose LLM is the null provider and whose discovery service is disabled —
 * the orchestrator handles both, and the bot behaves exactly as it did before
 * any of this existed.
 */
import type { PrismaClient } from '@discord-music/database';
import type { Redis } from '@discord-music/shared/redis';

import type { BotEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

import { AutoplayPlanner, type DislikeSource } from './autoplay-planner.js';
import { AutoplayEngine } from './autoplay.js';
import { CacheService } from './cache.js';
import { CooccurrenceService } from './cooccurrence.js';
import { TrackProfileResolver } from './track-profile.js';
import { FamiliarPoolService } from './familiar.js';
import { IntentService } from './intent.js';
import { LastFmService } from './lastfm.js';
import { GroqProvider } from './llm/groq.js';
import { type LLMProvider, NULL_PROVIDER } from './llm/provider.js';
import { MusicBrainzService } from './musicbrainz.js';
import { MusicOrchestrator } from './orchestrator.js';
import { RecommendationService } from './recommender.js';
import { ShortlistReranker } from './rerank.js';
import { AutoplaySessionStore } from './session.js';
import { UserTasteService } from './taste.js';

const logger = getLogger('ai');

export interface AiStack {
  readonly orchestrator: MusicOrchestrator;
  readonly autoplay: AutoplayEngine;
  /** Chooses autoplay's songs: known-pool selection plus discovery slots. */
  readonly planner: AutoplayPlanner;
  readonly cache: CacheService;
  /** Per-guild played/queued/reserved state; the anti-repeat ledger. */
  readonly session: AutoplaySessionStore;
}

export function createAiStack(options: {
  readonly env: BotEnv;
  readonly prisma: PrismaClient;
  readonly redis?: Redis;
  /** Explicit "not like" store; absent means dislikes are session-only. */
  readonly dislikes?: DislikeSource;
}): AiStack {
  const { env, prisma, redis, dislikes } = options;

  const cache = new CacheService(redis);

  const llm: LLMProvider =
    env.GROQ_API_KEY === undefined
      ? NULL_PROVIDER
      : new GroqProvider({
          apiKey: env.GROQ_API_KEY,
          model: env.GROQ_MODEL,
          timeoutMs: env.GROQ_TIMEOUT_MS,
          reasoningEffort: env.GROQ_REASONING_EFFORT,
        });

  const lastfm = new LastFmService(cache, env.LASTFM_API_KEY);
  const musicbrainz = new MusicBrainzService(cache, env.MUSICBRAINZ_ENABLED);
  const taste = new UserTasteService(prisma, cache, lastfm, musicbrainz);
  const recommender = new RecommendationService(
    lastfm,
    cache,
    {
      poolSize: env.RECOMMENDATION_POOL_SIZE,
      concurrency: env.RECOMMENDATION_CONCURRENCY,
    },
    new ShortlistReranker(llm),
  );

  // Metadata enrichment: one resolver, one cache, shared by autoplay's known
  // pool and by /ask's answers. Tags come from the recommender's cached
  // artist-tag lookup and the artist's country from MusicBrainz.
  // Two resolvers over one cache. Autoplay's runs on Last.fm tags alone:
  // MusicBrainz serialises at one request per second, and a refill that
  // waits on a queue of those is heard as silence. /ask's answers can afford
  // the artist's country.
  const profiles = new TrackProfileResolver(
    { artistTags: (artist) => recommender.artistTags(artist) },
    cache,
  );
  const informProfiles = new TrackProfileResolver(
    {
      artistTags: (artist) => recommender.artistTags(artist),
      artistCountry: async (artist) => (await musicbrainz.canonicalArtist(artist)).country,
    },
    cache,
  );

  // The session store is constructed BEFORE the orchestrator on purpose: the
  // orchestrator needs it so /ask runs under the same exclusions and
  // reservations as autoplay. Without it, the two paths race each other for
  // the same guild and can select the same song.
  const session = new AutoplaySessionStore(redis === undefined ? {} : { redis });

  const orchestrator = new MusicOrchestrator({
    intent: new IntentService(llm),
    taste,
    recommender,
    lastfm,
    musicbrainz,
    cache,
    session,
    inform: {
      artistTags: (artist) => recommender.artistTags(artist),
      similarArtists: async (artist) =>
        (await lastfm.similarArtists(artist, 8)).map((entry) => entry.name),
      profile: (input) => informProfiles.resolve(input),
    },
  });

  // Autoplay proper: the planner keeps the listener's own songs (library,
  // playlists, history, requests) apart from the similarity engine's output
  // and decides the rhythm between them. The engine only buffers what the
  // planner chooses.
  const familiar = new FamiliarPoolService(prisma, cache);
  const planner = new AutoplayPlanner({
    session,
    taste,
    familiar,
    recommender,
    ...(dislikes === undefined ? {} : { dislikes }),
    // Behavioural similarity stands in for the audio features no provider
    // exposes: what the room plays, saves and lists together.
    cooccurrence: new CooccurrenceService(prisma, cache),
    profiles,
    config: {
      repeatCooldownMs: env.AUTOPLAY_REPEAT_COOLDOWN_MINUTES * 60_000,
      interleave: {
        familiarRunMin: Math.min(env.AUTOPLAY_FAMILIAR_RUN_MIN, env.AUTOPLAY_FAMILIAR_RUN_MAX),
        familiarRunMax: env.AUTOPLAY_FAMILIAR_RUN_MAX,
        discoveryEnabled: env.AUTOPLAY_DISCOVERY_ENABLED,
      },
    },
  });
  const autoplay = new AutoplayEngine(planner, session, {
    prefetchSize: env.AUTOPLAY_PREFETCH_SIZE,
  });

  logger.info(
    {
      llm: llm.name,
      lastfm: lastfm.enabled,
      musicbrainz: musicbrainz.enabled,
      cache: redis === undefined ? 'memory' : 'redis+memory',
      familiarRun: `${String(planner.config.interleave.familiarRunMin)}-${String(planner.config.interleave.familiarRunMax)}`,
      discovery: planner.config.interleave.discoveryEnabled,
    },
    'Recommendation stack ready',
  );

  return { orchestrator, autoplay, planner, cache, session };
}

export { AutoplayEngine, AutoplayPlanner, CacheService, MusicOrchestrator };
export { AutoplaySessionStore } from './session.js';
export type { SessionEntry } from './session.js';
export type { MusicIntent } from './intent.js';

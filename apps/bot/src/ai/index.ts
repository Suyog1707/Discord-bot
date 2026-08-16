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

import { AutoplayEngine } from './autoplay.js';
import { CacheService } from './cache.js';
import { IntentService } from './intent.js';
import { LastFmService } from './lastfm.js';
import { GroqProvider } from './llm/groq.js';
import { type LLMProvider, NULL_PROVIDER } from './llm/provider.js';
import { MusicBrainzService } from './musicbrainz.js';
import { MusicOrchestrator } from './orchestrator.js';
import { RecommendationService } from './recommender.js';
import { UserTasteService } from './taste.js';

const logger = getLogger('ai');

export interface AiStack {
  readonly orchestrator: MusicOrchestrator;
  readonly autoplay: AutoplayEngine;
  readonly cache: CacheService;
}

export function createAiStack(options: {
  readonly env: BotEnv;
  readonly prisma: PrismaClient;
  readonly redis?: Redis;
}): AiStack {
  const { env, prisma, redis } = options;

  const cache = new CacheService(redis);

  const llm: LLMProvider =
    env.GROQ_API_KEY === undefined
      ? NULL_PROVIDER
      : new GroqProvider({
          apiKey: env.GROQ_API_KEY,
          model: env.GROQ_MODEL,
          timeoutMs: env.GROQ_TIMEOUT_MS,
        });

  const lastfm = new LastFmService(cache, env.LASTFM_API_KEY);
  const musicbrainz = new MusicBrainzService(cache, env.MUSICBRAINZ_ENABLED);
  const taste = new UserTasteService(prisma, cache, lastfm);
  const recommender = new RecommendationService(lastfm, cache, {
    poolSize: env.RECOMMENDATION_POOL_SIZE,
    concurrency: env.RECOMMENDATION_CONCURRENCY,
  });

  const orchestrator = new MusicOrchestrator({
    intent: new IntentService(llm),
    taste,
    recommender,
    lastfm,
    musicbrainz,
    cache,
  });

  const autoplay = new AutoplayEngine(orchestrator, {
    prefetchSize: env.AUTOPLAY_PREFETCH_SIZE,
  });

  logger.info(
    {
      llm: llm.name,
      lastfm: lastfm.enabled,
      musicbrainz: musicbrainz.enabled,
      cache: redis === undefined ? 'memory' : 'redis+memory',
    },
    'Recommendation stack ready',
  );

  return { orchestrator, autoplay, cache };
}

export { AutoplayEngine, CacheService, MusicOrchestrator };
export type { MusicIntent } from './intent.js';

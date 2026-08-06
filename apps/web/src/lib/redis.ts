import 'server-only';

/** Shared Redis connection for the web server (rate limiting, caching). */
import { getSharedRedis, type Redis } from '@discord-music/shared/redis';

import { getEnv } from './env';
import { getLogger } from './logger';

export function getRedis(): Redis {
  return getSharedRedis({
    url: getEnv().REDIS_URL,
    logger: getLogger('redis'),
  });
}

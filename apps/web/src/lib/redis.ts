import 'server-only';

/**
 * Shared Redis connection for the web server (rate limiting, caching).
 *
 * Returns `undefined` when `REDIS_URL` is unset — optional in development so
 * the dashboard runs without infrastructure. The env schema makes it mandatory
 * in production, so callers there always get a client; they must still handle
 * `undefined` and degrade rather than assume it is present.
 */
import { getSharedRedis, type Redis } from '@discord-music/shared/redis';

import { getEnv } from './env';
import { getLogger } from './logger';

export function getRedis(): Redis | undefined {
  const { REDIS_URL } = getEnv();
  if (REDIS_URL === undefined) return undefined;

  return getSharedRedis({ url: REDIS_URL, logger: getLogger('redis') });
}

/** Whether Redis-backed features can be enabled in this environment. */
export function isRedisConfigured(): boolean {
  return getEnv().REDIS_URL !== undefined;
}

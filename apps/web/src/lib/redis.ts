import 'server-only';

/**
 * Shared Redis connection for the web server (rate limiting, caching).
 *
 * Returns `undefined` when `REDIS_URL` is unset — optional in development so
 * the dashboard runs without infrastructure. The env schema makes it mandatory
 * in production, so callers there always get a client; they must still handle
 * `undefined` and degrade rather than assume it is present.
 */
import { connectRedis, getSharedRedis, type Redis } from '@discord-music/shared/redis';

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

/**
 * A client that is actually connected, not merely constructed.
 *
 * The shared client is lazy and refuses commands while offline rather than
 * queueing them, which is the right trade for a long-lived process: a command
 * issued during an outage should fail rather than pile up. On serverless it
 * has a sharper edge — the *first* request an instance serves arrives before
 * the connection exists, so it fails on a working Redis.
 *
 * That is invisible on a page that retries and merely annoying on a dashboard
 * click. On the command router it is a slash command answered with "the bot's
 * control channel is unavailable" for no reason other than the instance being
 * new, which is exactly the sort of intermittent failure nobody can reproduce.
 */
export async function getReadyRedis(): Promise<Redis | undefined> {
  const redis = getRedis();
  if (redis === undefined) return undefined;
  await connectRedis(redis);
  return redis;
}

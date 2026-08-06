/**
 * `GET /api/health` — liveness and dependency readiness probe.
 *
 * Used by Vercel/uptime monitoring and as the Phase 1 end-to-end check that the
 * web app can actually reach Postgres and Redis. Returns 200 when every
 * dependency responds and 503 otherwise, so a load balancer can act on it.
 */
import { pingDatabase } from '@discord-music/database';

import { apiSuccess, withErrorHandling } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRedis } from '@/lib/redis';

// Always execute; a cached health check is worse than no health check.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type DependencyStatus = 'up' | 'down';

interface HealthPayload {
  readonly status: 'healthy' | 'degraded';
  readonly uptimeSeconds: number;
  readonly timestamp: string;
  readonly dependencies: {
    readonly database: DependencyStatus;
    readonly redis: DependencyStatus;
  };
}

async function pingRedis(): Promise<boolean> {
  try {
    // A resolved PING is the signal; ioredis rejects if the socket is unusable.
    await getRedis().ping();
    return true;
  } catch {
    return false;
  }
}

export const GET = withErrorHandling('GET /api/health', async () => {
  // Probe in parallel so a slow dependency does not serialise the check.
  const [databaseUp, redisUp] = await Promise.all([pingDatabase(getDb()), pingRedis()]);

  const healthy = databaseUp && redisUp;

  const payload: HealthPayload = {
    status: healthy ? 'healthy' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies: {
      database: databaseUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
    },
  };

  return apiSuccess(payload, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
});

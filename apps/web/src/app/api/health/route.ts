/**
 * `GET /api/health` — liveness and dependency readiness probe.
 *
 * Used by Vercel/uptime monitoring and as the Phase 1 end-to-end check that the
 * web app can reach its dependencies.
 *
 * The HTTP status reflects only *required* dependencies, so a load balancer
 * acts on real outages. See `resolveHealth` for the rule.
 */
import { pingDatabase } from '@discord-music/database';

import { apiSuccess, withErrorHandling } from '@/lib/api';
import { getDb } from '@/lib/db';
import { isProduction } from '@/lib/env';
import { resolveHealth, type DependencyStatus, type HealthStatus } from '@/lib/health';
import { getRedis } from '@/lib/redis';

// Always execute; a cached health check is worse than no health check.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface HealthPayload {
  readonly status: HealthStatus;
  readonly uptimeSeconds: number;
  readonly timestamp: string;
  readonly dependencies: {
    readonly database: DependencyStatus;
    readonly redis: DependencyStatus;
  };
}

async function checkRedis(): Promise<DependencyStatus> {
  const redis = getRedis();
  if (redis === undefined) return 'not_configured';

  try {
    // A resolved PING is the signal; ioredis rejects if the socket is unusable.
    await redis.ping();
    return 'up';
  } catch {
    return 'down';
  }
}

export const GET = withErrorHandling('GET /api/health', async () => {
  // Probe in parallel so a slow dependency does not serialise the check.
  const [databaseUp, redis] = await Promise.all([pingDatabase(getDb()), checkRedis()]);

  const dependencies = {
    database: (databaseUp ? 'up' : 'down') satisfies DependencyStatus as DependencyStatus,
    redis,
  };

  const { status, httpStatus } = resolveHealth(dependencies, isProduction());

  const payload: HealthPayload = {
    status,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies,
  };

  return apiSuccess(payload, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
});

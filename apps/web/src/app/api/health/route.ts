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
import { getEnv, isProduction } from '@/lib/env';
import { resolveHealth, type DependencyStatus, type HealthStatus } from '@/lib/health';
import { getReadyRedis, isRedisConfigured } from '@/lib/redis';

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
  /**
   * Whether this deployment can serve slash commands.
   *
   * Booleans, never values. Both are easy to forget when promoting a
   * deployment, and each fails in a way that looks like something else: with
   * no public key every command is refused as a forgery, and with no bot token
   * the router cannot ask Discord where the caller is standing, so `/play`
   * tells people to join a voice channel they are already in. Neither says so
   * out loud, which is why they are worth reporting.
   */
  readonly router: {
    readonly signatureKey: boolean;
    readonly botToken: boolean;
  };
}

async function checkRedis(): Promise<DependencyStatus> {
  if (!isRedisConfigured()) return 'not_configured';

  try {
    /**
     * Connect, then ping — not ping alone.
     *
     * The shared client is lazy, so on the first request an instance serves
     * there is no socket yet and a bare ping fails on a perfectly healthy
     * Redis. That made the probe report `unhealthy` with a 503 for the first
     * few seconds of every cold start, which is exactly the sort of thing a
     * monitor pages somebody about at three in the morning.
     *
     * `connectRedis` still throws when Redis is genuinely unreachable, so a
     * real outage reports `down` as before.
     */
    await getReadyRedis();
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

  const env = getEnv();
  const payload: HealthPayload = {
    status,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies,
    router: {
      signatureKey: env.BOT_PUBLIC_KEY !== undefined,
      botToken: env.BOT_TOKEN !== undefined,
    },
  };

  return apiSuccess(payload, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
});

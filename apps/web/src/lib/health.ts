/**
 * Health status rules.
 *
 * Kept out of the route module so the decision is unit-testable: Next.js only
 * permits a fixed set of exports from a `route.ts`, and this rule is exactly
 * the kind of logic worth testing directly rather than through HTTP.
 */

/** `not_configured` is distinct from `down`: nothing is broken, it is switched off. */
export type DependencyStatus = 'up' | 'down' | 'not_configured';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyReport {
  readonly database: DependencyStatus;
  readonly redis: DependencyStatus;
}

export interface HealthResult {
  readonly status: HealthStatus;
  /** HTTP status: 503 only when a *required* dependency is unavailable. */
  readonly httpStatus: 200 | 503;
}

/**
 * Decide overall health from individual dependency states.
 *
 * PostgreSQL is required everywhere. Redis is required only in production —
 * in development it may be absent or down, and the app still serves traffic
 * correctly without it, so that reports `degraded` with a 200. A load balancer
 * should only take an instance out of rotation for a real outage.
 *
 * @param dependencies - Observed state of each dependency.
 * @param redisRequired - Whether Redis is mandatory in this environment.
 */
export function resolveHealth(
  dependencies: DependencyReport,
  redisRequired: boolean,
): HealthResult {
  const unhealthy =
    dependencies.database !== 'up' || (redisRequired && dependencies.redis !== 'up');

  if (unhealthy) return { status: 'unhealthy', httpStatus: 503 };
  if (dependencies.redis !== 'up') return { status: 'degraded', httpStatus: 200 };

  return { status: 'healthy', httpStatus: 200 };
}

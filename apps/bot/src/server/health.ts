/**
 * What "healthy" means for one bot container.
 *
 * Kept pure and separate from the server so the rule can be tested directly,
 * and because it does double duty: it answers Docker's healthcheck, and later
 * it decides whether a container should quit so the restart policy can give it
 * a fresh connection.
 *
 * The vocabulary matches the dashboard's (`apps/web/src/lib/health.ts`) —
 * `not_configured` is deliberately distinct from `down`, because nothing being
 * broken and something being switched off are different answers.
 */

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface BotDependencyReport {
  /** The Discord gateway connection. Without it the bot can do nothing at all. */
  readonly gateway: DependencyStatus;
  readonly lavalink: DependencyStatus;
  readonly database: DependencyStatus;
  readonly redis: DependencyStatus;
}

export interface HealthResult {
  readonly status: HealthStatus;
  /** 503 only when restarting this container would actually help. */
  readonly httpStatus: 200 | 503;
}

/**
 * Only the gateway can make a container unhealthy.
 *
 * This is the load-bearing decision, and it is deliberately narrow. A bot with
 * no gateway is inert and a restart genuinely fixes it. A bot that has lost
 * Lavalink, Postgres or Redis is *degraded* — it is still connected, still
 * holding its voice channels, and every one of those dependencies reconnects on
 * its own. Marking them unhealthy would mean that a single Lavalink hiccup
 * restarts the entire fleet at once, turning a recoverable blip into an outage
 * and losing every queue in the process.
 *
 * So: report the truth about all four, but only ever ask to be replaced over
 * the one a replacement would repair.
 */
export function resolveBotHealth(dependencies: BotDependencyReport): HealthResult {
  if (dependencies.gateway !== 'up') return { status: 'unhealthy', httpStatus: 503 };

  const degraded = (['lavalink', 'database', 'redis'] as const).some(
    (name) => dependencies[name] === 'down',
  );
  return degraded
    ? { status: 'degraded', httpStatus: 200 }
    : { status: 'healthy', httpStatus: 200 };
}

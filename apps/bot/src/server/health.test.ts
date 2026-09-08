/**
 * What makes a container unhealthy.
 *
 * This rule does double duty: it answers Docker's healthcheck, and it decides
 * whether a container should quit so the restart policy can replace it. The
 * cases that matter most are the ones that must NOT ask for a restart — a
 * fleet that restarts itself over a Lavalink blip turns a recoverable hiccup
 * into an outage and loses every queue with it.
 */
import { describe, expect, it } from 'vitest';

import { resolveBotHealth, type BotDependencyReport } from './health.js';

function deps(overrides: Partial<BotDependencyReport> = {}): BotDependencyReport {
  return { gateway: 'up', lavalink: 'up', database: 'up', redis: 'up', ...overrides };
}

describe('resolveBotHealth', () => {
  it('is healthy when everything is up', () => {
    expect(resolveBotHealth(deps())).toEqual({ status: 'healthy', httpStatus: 200 });
  });

  /** The one thing a restart actually repairs. */
  it('is unhealthy without a gateway', () => {
    expect(resolveBotHealth(deps({ gateway: 'down' }))).toEqual({
      status: 'unhealthy',
      httpStatus: 503,
    });
  });

  it.each(['lavalink', 'database', 'redis'] as const)(
    'is only degraded when %s is down, never unhealthy',
    (name) => {
      const health = resolveBotHealth(deps({ [name]: 'down' }));

      expect(health.status).toBe('degraded');
      // 200 on purpose: restarting this container would not bring the
      // dependency back, and would drop the rooms it is holding.
      expect(health.httpStatus).toBe(200);
    },
  );

  it('stays degraded rather than unhealthy with everything but the gateway down', () => {
    const health = resolveBotHealth(deps({ lavalink: 'down', database: 'down', redis: 'down' }));

    expect(health).toEqual({ status: 'degraded', httpStatus: 200 });
  });

  /** Switched off is not broken — a dev box without Redis is healthy. */
  it('treats an unconfigured dependency as healthy, not degraded', () => {
    expect(resolveBotHealth(deps({ redis: 'not_configured' }))).toEqual({
      status: 'healthy',
      httpStatus: 200,
    });
    expect(resolveBotHealth(deps({ lavalink: 'not_configured' }))).toEqual({
      status: 'healthy',
      httpStatus: 200,
    });
  });

  /** A missing gateway outranks everything, however well the rest is doing. */
  it('reports unhealthy for a lost gateway even when all else is fine', () => {
    expect(resolveBotHealth(deps({ gateway: 'not_configured' })).status).toBe('unhealthy');
  });
});

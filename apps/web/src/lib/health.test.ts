import { describe, expect, it } from 'vitest';

import { resolveHealth, type DependencyStatus } from './health';

describe('resolveHealth', () => {
  describe('development (Redis optional)', () => {
    const inDevelopment = (redis: DependencyStatus) =>
      resolveHealth({ database: 'up', redis }, false);

    it('is healthy when everything is up', () => {
      expect(inDevelopment('up')).toEqual({ status: 'healthy', httpStatus: 200 });
    });

    it('serves 200 when Redis is not configured', () => {
      // The whole point of the change: no Redis locally must not fail the probe.
      expect(inDevelopment('not_configured')).toEqual({ status: 'degraded', httpStatus: 200 });
    });

    it('serves 200 when Redis is configured but down', () => {
      expect(inDevelopment('down')).toEqual({ status: 'degraded', httpStatus: 200 });
    });

    it('is unhealthy when the database is down, regardless of Redis', () => {
      for (const redis of ['up', 'down', 'not_configured'] as const) {
        expect(resolveHealth({ database: 'down', redis }, false)).toEqual({
          status: 'unhealthy',
          httpStatus: 503,
        });
      }
    });
  });

  describe('production (Redis required)', () => {
    const inProduction = (redis: DependencyStatus) =>
      resolveHealth({ database: 'up', redis }, true);

    it('is healthy when everything is up', () => {
      expect(inProduction('up')).toEqual({ status: 'healthy', httpStatus: 200 });
    });

    it('is unhealthy when Redis is down', () => {
      expect(inProduction('down')).toEqual({ status: 'unhealthy', httpStatus: 503 });
    });

    it('is unhealthy when Redis is not configured', () => {
      expect(inProduction('not_configured')).toEqual({ status: 'unhealthy', httpStatus: 503 });
    });
  });
});

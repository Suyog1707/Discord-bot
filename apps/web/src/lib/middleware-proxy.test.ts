import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '../../middleware';

afterEach(() => vi.unstubAllEnvs());

describe('Vercel backend proxy', () => {
  it('keeps the original routes when the proxy is disabled', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('BACKEND_PROXY_ENABLED', '');
    expect(
      middleware(new NextRequest('https://music.example.com/api/health')).headers.get(
        'x-middleware-next',
      ),
    ).toBe('1');
    expect(
      middleware(new NextRequest('https://music.example.com/dashboard')).headers.get('location'),
    ).toContain('/login?callbackUrl=%2Fdashboard');
  });

  it('fails closed when enabled without a valid backend or secret', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('BACKEND_PROXY_ENABLED', 'true');
    vi.stubEnv('BACKEND_PROXY_URL', 'https://device.tailnet.ts.net');
    vi.stubEnv('ORIGIN_SECRET', '');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);

    vi.stubEnv('ORIGIN_SECRET', 'test-secret');
    vi.stubEnv('BACKEND_PROXY_URL', 'http://device.tailnet.ts.net');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);
    vi.stubEnv('BACKEND_PROXY_URL', 'https://music.example.com');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);
  });

  it('rewrites all paths with trusted gateway headers', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('BACKEND_PROXY_ENABLED', 'true');
    vi.stubEnv('BACKEND_PROXY_URL', 'https://device.tailnet.ts.net');
    vi.stubEnv('ORIGIN_SECRET', 'server-secret');

    const response = middleware(
      new NextRequest('https://music.example.com/api/health?probe=1', {
        headers: { 'x-origin-secret': 'visitor-secret', 'x-public-host': 'attacker.example' },
      }),
    );
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://device.tailnet.ts.net/api/health?probe=1',
    );
    expect(response.headers.get('x-middleware-request-x-origin-secret')).toBe('server-secret');
    expect(response.headers.get('x-middleware-request-x-public-host')).toBe('music.example.com');
    expect(response.headers.get('x-origin-secret')).toBeNull();
  });
});

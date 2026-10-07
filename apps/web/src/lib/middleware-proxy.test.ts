import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '../middleware';

afterEach(() => vi.unstubAllEnvs());

describe('Vercel backend proxy', () => {
  it('keeps backend login redirects on the configured public origin', () => {
    vi.stubEnv('WEB_BACKEND_LOCAL', 'true');
    vi.stubEnv('BACKEND_PROXY_ENABLED', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://music.example.com');
    const response = middleware(new NextRequest('http://0.0.0.0:3000/dashboard/settings'));
    expect(response.headers.get('location')).toBe(
      'https://music.example.com/login?callbackUrl=%2Fdashboard%2Fsettings',
    );
  });
  it('keeps the original routes only on the explicitly local backend', () => {
    vi.stubEnv('BACKEND_PROXY_ENABLED', '');
    vi.stubEnv('WEB_BACKEND_LOCAL', 'true');
    const response = middleware(new NextRequest('https://music.example.com/api/health'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-music-proxy-mode')).toBe('off');
    expect(
      middleware(new NextRequest('https://music.example.com/dashboard')).headers.get('location'),
    ).toContain('/login?callbackUrl=%2Fdashboard');
  });

  it('fails closed on Vercel when proxy mode is absent or conflicts', () => {
    vi.stubEnv('BACKEND_PROXY_ENABLED', '');
    vi.stubEnv('WEB_BACKEND_LOCAL', '');
    expect(middleware(new NextRequest('https://music.example.com/api/health')).status).toBe(503);

    vi.stubEnv('BACKEND_PROXY_ENABLED', 'true');
    vi.stubEnv('WEB_BACKEND_LOCAL', 'true');
    expect(middleware(new NextRequest('https://music.example.com/api/health')).status).toBe(503);
  });

  it('fails closed when enabled without a valid backend or secret', () => {
    vi.stubEnv('BACKEND_PROXY_ENABLED', 'true');
    vi.stubEnv('WEB_BACKEND_LOCAL', '');
    vi.stubEnv('BACKEND_PROXY_URL', 'https://device.tailnet.ts.net');
    vi.stubEnv('ORIGIN_SECRET', '');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);

    vi.stubEnv('ORIGIN_SECRET', 'test-secret');
    vi.stubEnv('BACKEND_PROXY_URL', 'http://device.tailnet.ts.net');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);
    vi.stubEnv('BACKEND_PROXY_URL', 'https://music.example.com');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);
    vi.stubEnv('BACKEND_PROXY_URL', 'https://user:pass@device.tailnet.ts.net');
    expect(middleware(new NextRequest('https://music.example.com/')).status).toBe(503);
  });

  it('rewrites all paths with trusted gateway headers', () => {
    vi.stubEnv('BACKEND_PROXY_ENABLED', 'true');
    vi.stubEnv('WEB_BACKEND_LOCAL', '');
    vi.stubEnv('BACKEND_PROXY_URL', 'https://device.tailnet.ts.net/copied/path?unused=1#fragment');
    vi.stubEnv('ORIGIN_SECRET', 'server-secret');

    const response = middleware(
      new NextRequest('https://music.example.com/api/health?probe=1', {
        headers: { 'x-origin-secret': 'visitor-secret', 'x-public-host': 'attacker.example' },
      }),
    );
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://device.tailnet.ts.net/api/health?probe=1',
    );
    expect(response.headers.get('x-music-proxy-mode')).toBe('forward');
    expect(response.headers.get('x-middleware-request-x-origin-secret')).toBe('server-secret');
    expect(response.headers.get('x-middleware-request-x-public-host')).toBe('music.example.com');
    expect(response.headers.get('x-origin-secret')).toBeNull();
  });
});

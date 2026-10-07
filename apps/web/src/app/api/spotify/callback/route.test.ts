import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const completeLink = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/lib/services/spotify', () => ({ completeLink }));
vi.mock('@/lib/auth/session', () => ({ requireUser: () => Promise.resolve({ id: 'user' }) }));
vi.mock('@/lib/api', () => ({ withErrorHandling: (_name: string, handler: unknown) => handler }));
vi.mock('@/lib/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ NEXTAUTH_URL: 'https://music.example.com', NODE_ENV: 'production' }),
}));
import { GET } from './route';

function request(query: string, cookie = 'state') {
  return new NextRequest(`http://0.0.0.0:3000/api/spotify/callback?${query}`, {
    headers: { cookie: `spotify_oauth_state=${cookie}`, host: 'attacker.example' },
  });
}
beforeEach(() => completeLink.mockClear());
describe('Spotify callback behind Docker proxy', () => {
  it('stores the link then redirects to the public HTTPS website', async () => {
    const response = await GET(request('code=test-code&state=state'));
    expect(completeLink).toHaveBeenCalledWith('user', 'test-code');
    expect(response.headers.get('location')).toBe(
      'https://music.example.com/dashboard/settings?spotify=linked',
    );
    expect(response.headers.get('set-cookie')).toContain('Path=/api/spotify');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each(['code=test-code&state=wrong', 'code=test-code', 'state=state'])(
    'refuses invalid callbacks: %s',
    async (query) => {
      expect((await GET(request(query))).headers.get('location')).toContain('spotify=invalid');
      expect(completeLink).not.toHaveBeenCalled();
    },
  );
  it('handles denied authorization without exchanging a code', async () => {
    expect((await GET(request('error=access_denied'))).headers.get('location')).toContain(
      'spotify=denied',
    );
    expect(completeLink).not.toHaveBeenCalled();
  });
  it('returns a safe public redirect when token exchange fails', async () => {
    completeLink.mockRejectedValueOnce(new Error('Spotify unavailable'));
    expect((await GET(request('code=test-code&state=state'))).headers.get('location')).toBe(
      'https://music.example.com/dashboard/settings?spotify=failed',
    );
  });
});

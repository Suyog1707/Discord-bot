import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, NotFoundError, RateLimitError } from '@discord-music/shared';
vi.mock('./logger', () => ({ getLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));
import { handleApiError } from './api';

describe('API error boundary', () => {
  it('preserves specific expected failures', async () => {
    const response = handleApiError(new NotFoundError('This playlist was deleted.'), 'test');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { message: 'This playlist was deleted.' },
    });
  });
  it('returns Retry-After for rate limits', () => {
    const response = handleApiError(new RateLimitError(120), 'test');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('120');
  });
  it.each([new Error('password=secret'), new ConfigurationError('token=secret')])(
    'never returns private exception text',
    async (error) => {
      const response = handleApiError(error, 'test');
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('secret');
    },
  );
});

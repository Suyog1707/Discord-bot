import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '@discord-music/shared';

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    // Mirrors next/navigation: redirect() never returns, it throws a sentinel
    // the framework unwinds to. Tests assert on that control flow.
    const error = new Error(`NEXT_REDIRECT;${url}`);
    error.name = 'NextRedirectError';
    throw error;
  }),
);

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('./index', () => ({ auth: vi.fn() }));

const { withDiscordLink } = await import('./session');

describe('withDiscordLink', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it('returns the loaded value when the Discord link is healthy', async () => {
    await expect(withDiscordLink('/dashboard', () => Promise.resolve(['a']))).resolves.toEqual([
      'a',
    ]);
    expect(redirect).not.toHaveBeenCalled();
  });

  /**
   * The regression: a dead Discord authorization surfaced as a 500 mid-render
   * on /dashboard/servers, on a page offering no way to reconnect.
   */
  it('sends an expired Discord link to /login to reconnect', async () => {
    await expect(
      withDiscordLink('/dashboard/servers', () => {
        throw new UnauthenticatedError('Your Discord session has expired.');
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(redirect).toHaveBeenCalledWith('/login?reauth=1&callbackUrl=%2Fdashboard%2Fservers');
  });

  /** `reauth=1` is what stops /login bouncing a still-signed-in visitor back. */
  it('always asks /login to skip its signed-in shortcut', async () => {
    await expect(
      withDiscordLink('/dashboard', () => Promise.reject(new UnauthenticatedError())),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(redirect.mock.calls[0]?.[0]).toContain('reauth=1');
  });

  it('encodes the callback so the target survives the round trip', async () => {
    await expect(
      withDiscordLink('/dashboard/servers/123', () => Promise.reject(new UnauthenticatedError())),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(redirect).toHaveBeenCalledWith(
      '/login?reauth=1&callbackUrl=%2Fdashboard%2Fservers%2F123',
    );
  });

  /** Only a dead Discord link means "reconnect"; everything else is a real error. */
  it('lets other errors through untouched', async () => {
    await expect(
      withDiscordLink('/dashboard', () => Promise.reject(new ForbiddenError('nope'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(redirect).not.toHaveBeenCalled();
  });
});

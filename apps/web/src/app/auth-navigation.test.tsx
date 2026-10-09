import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  signIn: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mocks.user }));
vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import HomePage from './page';
import LoginPage from './login/page';
beforeEach(() => {
  mocks.user.mockReset();
  mocks.signIn.mockReset();
  mocks.redirect.mockClear();
});
afterEach(cleanup);
describe('session-aware entry pages', () => {
  it('starts sign-in through the client auth API with the requested dashboard destination', async () => {
    mocks.user.mockResolvedValue(null);
    render(
      await LoginPage({ searchParams: Promise.resolve({ callbackUrl: '/dashboard/settings' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Discord' }));
    await waitFor(() => {
      expect(mocks.signIn).toHaveBeenCalledWith('discord', { redirectTo: '/dashboard/settings' });
    });
  });
  it('shows a safe retry error when sign-in cannot start', async () => {
    mocks.user.mockResolvedValue(null);
    mocks.signIn.mockRejectedValue(new Error('private-token'));
    render(await HomePage());
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Discord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start Discord sign-in');
    expect(document.body.textContent).not.toContain('private-token');
  });
  it('offers dashboard directly to an authenticated visitor', async () => {
    mocks.user.mockResolvedValue({ id: 'user' });
    render(await HomePage());
    expect(screen.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.queryByRole('button', { name: 'Continue with Discord' })).toBeNull();
  });
  it('offers Discord sign-in directly on the home page without another login page', async () => {
    mocks.user.mockResolvedValue(null);
    render(await HomePage());
    expect(screen.getByRole('button', { name: 'Continue with Discord' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });
  it.each([undefined, '/login', '/login/', '/login?callbackUrl=/login', '/api/auth/signin'])(
    'never loops a signed-in user back to login (%s)',
    async (callbackUrl) => {
      mocks.user.mockResolvedValue({ id: 'user' });
      await expect(
        LoginPage({
          searchParams: Promise.resolve(callbackUrl === undefined ? {} : { callbackUrl }),
        }),
      ).rejects.toThrow('redirect:/dashboard');
    },
  );
  it('preserves the requested dashboard page for an authenticated session', async () => {
    mocks.user.mockResolvedValue({ id: 'user' });
    await expect(
      LoginPage({ searchParams: Promise.resolve({ callbackUrl: '/dashboard/settings' }) }),
    ).rejects.toThrow('redirect:/dashboard/settings');
  });
  it('still allows an authenticated user to explicitly reconnect expired Discord authorization', async () => {
    mocks.user.mockResolvedValue({ id: 'user' });
    render(await LoginPage({ searchParams: Promise.resolve({ reauth: '1' }) }));
    expect(screen.getByRole('button', { name: 'Reconnect with Discord' })).toBeVisible();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

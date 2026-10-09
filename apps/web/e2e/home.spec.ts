import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('uses the stable CSRF-protected auth API rather than a Server Action', async ({ page }) => {
    await page.route('**/api/auth/providers', (route) =>
      route.fulfill({
        json: {
          discord: {
            id: 'discord',
            name: 'Discord',
            type: 'oauth',
            signinUrl: '/api/auth/signin/discord',
            callbackUrl: '/api/auth/callback/discord',
          },
        },
      }),
    );
    await page.route('**/api/auth/csrf', (route) =>
      route.fulfill({ json: { csrfToken: 'test-csrf' } }),
    );
    await page.route('**/api/auth/signin/discord*', (route) =>
      route.fulfill({ json: { url: 'http://localhost:3000/login?started=1' } }),
    );
    await page.goto('/');
    const requestPromise = page.waitForRequest((request) =>
      request.url().includes('/api/auth/signin/discord'),
    );
    await page.getByRole('button', { name: 'Continue with Discord' }).click();
    const request = await requestPromise;
    expect(request.method()).toBe('POST');
    expect(request.headers()['next-action']).toBeUndefined();
    const body = new URLSearchParams(request.postData() ?? '');
    expect(body.get('csrfToken')).toBe('test-csrf');
    expect(body.get('callbackUrl')).toBe('/dashboard');
    await expect(page).toHaveURL(/started=1/);
  });
  test('renders the hero and feature cards', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Discord Music Platform' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Features' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Discord' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toHaveCount(0);
  });

  test('has no horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('health endpoint', () => {
  test('reports dependency status', async ({ request }) => {
    const response = await request.get('/api/health');
    const body = (await response.json()) as {
      success: boolean;
      data?: { status: string; dependencies: Record<string, string> };
    };

    // 503 is a valid outcome when Postgres/Redis are not running locally.
    expect([200, 503]).toContain(response.status());
    expect(body.success).toBe(true);
    expect(body.data?.dependencies).toHaveProperty('database');
    expect(body.data?.dependencies).toHaveProperty('redis');
  });
});

test.describe('unauthenticated security boundaries', () => {
  test('dashboard sends visitors to login', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.getByRole('button', { name: 'Continue with Discord' })).toBeVisible();
  });
  test('Spotify linking and callback require a Discord session', async ({ request }) => {
    for (const path of ['/api/spotify/authorize', '/api/spotify/callback?code=test&state=test']) {
      const response = await request.get(path);
      expect(response.status()).toBe(401);
      expect(response.headers().location).toBeUndefined();
    }
  });
});

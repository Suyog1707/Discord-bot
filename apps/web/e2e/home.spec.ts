import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('renders the hero and feature cards', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Discord Music Platform' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Features' })).toBeVisible();
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

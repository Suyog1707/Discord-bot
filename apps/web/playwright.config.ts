import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${String(PORT)}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // A committed `test.only` should fail CI, not silently skip the suite.
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Omitted locally so Playwright picks a worker count from the CPU count.
  // (`exactOptionalPropertyTypes` forbids passing an explicit `undefined`.)
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],

  // Reuse an already-running dev server locally; always start fresh in CI.
  webServer: {
    command: isCI ? 'pnpm run start' : 'pnpm run dev',
    url: BASE_URL,
    reuseExistingServer: !isCI && process.env.PLAYWRIGHT_FRESH_SERVER !== 'true',
    timeout: 120_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'bot',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * Dummy configuration for code paths that legitimately read env — the
     * registries log, and the logger needs a level. These values are never used
     * to reach a real service; anything touching Postgres, Redis, Lavalink or
     * the Discord gateway belongs in integration tests, not here.
     */
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      BOT_TOKEN: 'test-token',
      BOT_CLIENT_ID: '000000000000000001',
      BOT_PUBLIC_KEY: 'test-public-key',
      LAVALINK_HOST: 'localhost',
      LAVALINK_PORT: '2333',
      LAVALINK_PASSWORD: 'test',
      LAVALINK_SECURE: 'false',
    },
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] },
  },
});

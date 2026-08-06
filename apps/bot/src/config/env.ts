/**
 * The bot's validated configuration.
 *
 * This is the only module in `apps/bot` permitted to touch `process.env`, and
 * it does so through the shared schema so a missing variable fails with a
 * message naming every problem at once.
 *
 * Access is a function rather than a module-level constant so that importing a
 * module never triggers validation as a side effect — unit tests can import
 * `command-registry` without a populated `.env`. The bot process still
 * validates eagerly at startup (see `index.ts`), long before it connects.
 */
import { botEnvSchema, loadBotEnv, type BotEnv } from '@discord-music/shared/env';

export type { BotEnv };
export { botEnvSchema };

/** Validated environment. Memoised — validation runs once per process. */
export function getEnv(): BotEnv {
  return loadBotEnv();
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

/** Lavalink connection details. */
export interface LavalinkNode {
  readonly name: string;
  readonly url: string;
  readonly auth: string;
  readonly secure: boolean;
}

/**
 * Lavalink node descriptor, or `undefined` when Lavalink is not configured.
 *
 * Optional in development so the bot can run without an audio server; the env
 * schema guarantees it is present in production, so this never returns
 * `undefined` there. Wired into Shoukaku in Phase 4.
 */
export function getLavalinkNode(): LavalinkNode | undefined {
  const env = getEnv();

  if (env.LAVALINK_HOST === undefined || env.LAVALINK_PASSWORD === undefined) {
    return undefined;
  }

  return {
    name: 'main',
    url: `${env.LAVALINK_HOST}:${String(env.LAVALINK_PORT)}`,
    auth: env.LAVALINK_PASSWORD,
    secure: env.LAVALINK_SECURE,
  };
}

/** Whether music playback can be enabled at all. */
export function isLavalinkConfigured(): boolean {
  return getLavalinkNode() !== undefined;
}

/** Whether Redis-backed features (caching, rate limiting) can be enabled. */
export function isRedisConfigured(): boolean {
  return getEnv().REDIS_URL !== undefined;
}

import 'server-only';

/**
 * Server-side environment for the dashboard.
 *
 * `server-only` makes importing this from a client component a build error, so
 * secrets can never reach the browser bundle by accident (docs/SECURITY.md).
 * Client components use `@/lib/public-env` instead.
 *
 * Access is deliberately a function rather than a module-level constant:
 * `next build` imports every route module to collect metadata, and validating
 * at import time would make a build require production secrets. Validation
 * therefore happens on first use, at request time. `loadWebEnv` memoises, so
 * the cost is paid once per process. Use `pnpm run check:env` to verify
 * configuration ahead of time.
 */
import { loadWebEnv, type WebEnv } from '@discord-music/shared/env';

export function getEnv(): WebEnv {
  return loadWebEnv();
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

export type { WebEnv };

import 'server-only';

/**
 * Root logger for the web server. Server components and route handlers only.
 *
 * Constructed lazily for the same reason as `env`: nothing may read
 * configuration while `next build` is collecting page data.
 */
import { childLogger, createLogger, type Logger } from '@discord-music/shared/logger';

import { getEnv, isProduction } from './env';

let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  return (rootLogger ??= createLogger({
    name: 'web',
    level: getEnv().LOG_LEVEL,
    pretty: !isProduction(),
  }));
}

/** `getLogger('api:health')` → records tagged `module=api:health`. */
export function getLogger(module: string): Logger {
  return childLogger(getRootLogger(), module);
}

export type { Logger };

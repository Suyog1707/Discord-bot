/**
 * Root logger for the bot process.
 *
 * Modules call `getLogger('name')` at module scope, but constructing a real
 * pino instance needs validated configuration. `getLogger` therefore returns a
 * proxy that builds the underlying logger on first use, keeping module imports
 * free of side effects so unit tests can import any module without a populated
 * `.env`. The bot still validates eagerly at startup (see `index.ts`).
 */
import { createLogger, type Logger } from '@discord-music/shared/logger';

import { getEnv, isProduction } from '../config/env.js';

let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  return (rootLogger ??= createLogger({
    name: 'bot',
    level: getEnv().LOG_LEVEL,
    pretty: !isProduction(),
  }));
}

/** Proxy that defers construction of the real logger until a property is touched. */
function lazyLogger(resolve: () => Logger): Logger {
  return new Proxy({} as Logger, {
    get: (_target, property) => Reflect.get(resolve(), property) as unknown,
    set: (_target, property, value) => Reflect.set(resolve(), property, value),
    has: (_target, property) => Reflect.has(resolve(), property),
  });
}

/** `getLogger('commands')` → records tagged `module=commands`. */
export function getLogger(module: string): Logger {
  return lazyLogger(() => getRootLogger().child({ module }));
}

/** Process-wide logger, resolved on first use. */
export const logger: Logger = lazyLogger(getRootLogger);

export type { Logger };

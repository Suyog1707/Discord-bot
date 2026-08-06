import 'server-only';

/**
 * Shared PrismaClient for the web server.
 *
 * Created on first use and cached on `globalThis`, so hot-reloads in
 * development reuse one connection pool instead of exhausting Postgres.
 */
import { getPrismaClient, type PrismaClient } from '@discord-music/database';

import { getEnv, isDevelopment } from './env';

export function getDb(): PrismaClient {
  const env = getEnv();
  return getPrismaClient({
    databaseUrl: env.DATABASE_URL,
    logQueries: isDevelopment() && env.LOG_LEVEL === 'trace',
  });
}

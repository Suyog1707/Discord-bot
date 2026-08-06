import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Replaces the deprecated `package.json#prisma` key (removed in Prisma 7).
 *
 * Prisma only auto-loads a `.env` next to the schema or the package root, but
 * this repo keeps a single `.env` at the monorepo root so the apps and the
 * database package cannot drift. Loading it here makes `prisma validate`,
 * `migrate` and `studio` work from any directory. Values already present in the
 * environment (CI, the shell, a deploy platform) take precedence.
 */
const rootEnvPath = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

export default defineConfig({
  schema: join('prisma', 'schema.prisma'),
  migrations: {
    path: join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});

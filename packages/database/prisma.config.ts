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

/**
 * `directUrl` in the schema is a hard requirement once declared: with no
 * DIRECT_URL in the environment every Prisma command fails validation, and that
 * includes `prisma generate` — which runs during `pnpm build` in CI and on
 * Vercel, where nothing ever migrates and only DATABASE_URL exists.
 *
 * Falling back to the pooler keeps those builds working. It does not paper over
 * a broken migration: a migrate command that lands on the pooler fails loudly
 * with a prepared-statement or advisory-lock error, which is the same signal as
 * before this split existed.
 */
if ((process.env.DIRECT_URL ?? '').trim() === '' && process.env.DATABASE_URL !== undefined) {
  // Blank counts as unset: `.env.example` ships `DIRECT_URL=` empty for setups
  // with no pooler, and an empty string would otherwise reach Prisma as a
  // malformed connection string rather than falling back.
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

export default defineConfig({
  schema: join('prisma', 'schema.prisma'),
  migrations: {
    path: join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});

/**
 * Pre-commit checks (run by the husky `pre-commit` hook).
 *
 * Scoped to staged files only, so committing stays fast. Full-repo `lint`,
 * `typecheck` and `test` run in CI.
 *
 * `--no-warn-ignored` matters here: lint-staged passes explicit paths, and
 * ESLint warns when a named file matches an ignore pattern. Combined with
 * `--max-warnings=0` that would fail the commit whenever a generated file such
 * as `next-env.d.ts` is staged.
 */
const eslint = 'eslint --fix --max-warnings=0 --no-warn-ignored';

export default {
  '*.{ts,tsx,mts,cts}': [eslint, 'prettier --write'],
  '*.{js,jsx,mjs,cjs}': [eslint, 'prettier --write'],
  '*.{json,md,yml,yaml,css}': ['prettier --write'],
  '*.prisma': ['prisma format --schema'],
};

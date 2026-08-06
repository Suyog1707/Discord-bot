// @ts-check
/**
 * Root ESLint flat config.
 *
 * Every workspace package re-exports the relevant preset from here so lint rules
 * live in exactly one place (PROJECT_RULES.md: "No duplicate code").
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Paths never worth linting, in any package. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/next-env.d.ts',
  '**/generated/**',
];

/**
 * Base preset: JS + TypeScript with type-aware rules.
 *
 * @param {{ tsconfigRootDir: string }} options
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function baseConfig({ tsconfigRootDir }) {
  return tseslint.config(
    { ignores },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
        globals: { ...globals.node, ...globals.es2023 },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        // Unused vars are errors, but `_`-prefixed identifiers are an explicit opt-out.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            ignoreRestSiblings: true,
          },
        ],
        // Enforce `import type` so runtime imports stay explicit (verbatimModuleSyntax).
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
        // Floating promises are the #1 source of silent failures in bots and route handlers.
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        // We use `unknown`-typed catch clauses plus custom error classes instead of `any`.
        '@typescript-eslint/no-explicit-any': 'error',
        'no-console': ['error', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'prefer-const': 'error',
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "MemberExpression[object.name='process'][property.name='env'] > Identifier.property",
            message:
              'Read environment variables through the validated env schema (@discord-music/shared/env), never process.env directly.',
          },
        ],
      },
    },
    // The env schema module is the one authorised reader of `process.env` —
    // it is what every other module goes through.
    {
      // Glob is cwd-relative: `eslint .` runs from inside each package.
      files: ['**/src/env/**'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    // Plain-JS config files sit outside every tsconfig, so type-aware rules
    // cannot run on them. Lint them syntactically instead of excluding them.
    {
      files: ['**/*.{mjs,cjs,js}'],
      extends: [tseslint.configs.disableTypeChecked],
      rules: {
        'no-console': 'off',
        'no-restricted-syntax': 'off',
      },
    },
    // Config files, scripts, seeds and tests get a looser rule set: they run on
    // a developer's machine or in CI, not on a request path.
    {
      files: [
        '**/*.config.{ts,mts,cts}',
        '**/scripts/**',
        '**/prisma/seed.ts',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
      ],
      rules: {
        'no-console': 'off',
        'no-restricted-syntax': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    prettier,
  );
}

export default baseConfig({ tsconfigRootDir: import.meta.dirname });

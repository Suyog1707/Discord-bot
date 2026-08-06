/**
 * Environment variable validation.
 *
 * Nothing in this repo reads `process.env` directly (an ESLint rule enforces
 * it). Each runtime calls the loader it needs, gets a frozen, fully-typed
 * object back, and crashes at boot with an actionable message if anything is
 * missing — never at 3am on a request path.
 *
 * Variable names match docs/ENVIRONMENT_VARIABLES.md and `.env.example`.
 */
import { z } from 'zod';

import { SNOWFLAKE_PATTERN } from '../constants/index.js';
import { ConfigurationError } from '../errors/index.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info');

const snowflake = z.string().regex(SNOWFLAKE_PATTERN, 'Must be a valid Discord ID.');

/** Accepts `true/false`, `1/0`, `yes/no`; tolerates surrounding whitespace. */
const booleanish = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const port = z.coerce.number().int().min(1).max(65_535);

const url = z.url('Must be an absolute URL, e.g. https://example.com');

/**
 * Mark a variable optional, treating a blank value as "not set".
 *
 * `.env.example` lists optional keys with empty values, and Node's `--env-file`
 * loads those as empty strings rather than omitting them. Without this, an
 * untouched optional key fails validation instead of falling back to its
 * default.
 */
function optional<TSchema extends z.ZodType>(schema: TSchema) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/** Present in every runtime. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
});

/** Required by anything that talks to Postgres or Redis. */
export const dataEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required.')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string.',
    ),
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required.')
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'REDIS_URL must start with redis:// or rediss://.',
    ),
});

/** Dashboard (`apps/web`) — server side only. */
export const webEnvSchema = baseEnvSchema.extend(dataEnvSchema.shape).extend({
  NEXT_PUBLIC_APP_URL: url,
  NEXTAUTH_URL: url,
  NEXTAUTH_SECRET: z
    .string()
    .min(32, 'NEXTAUTH_SECRET must be at least 32 characters. Generate: openssl rand -base64 32'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required.'),
});

/** Values safe to expose to the browser bundle. Keep this list minimal. */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: url,
});

/** Bot (`apps/bot`). */
export const botEnvSchema = baseEnvSchema.extend(dataEnvSchema.shape).extend({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required.'),
  BOT_CLIENT_ID: snowflake,
  BOT_PUBLIC_KEY: z.string().min(1, 'BOT_PUBLIC_KEY is required.'),
  /** Register slash commands to one guild for instant iteration during development. */
  BOT_DEV_GUILD_ID: optional(snowflake),
  LAVALINK_HOST: z.string().min(1, 'LAVALINK_HOST is required.'),
  LAVALINK_PORT: port.default(2333),
  LAVALINK_PASSWORD: z.string().min(1, 'LAVALINK_PASSWORD is required.'),
  LAVALINK_SECURE: booleanish.default(false),
});

export type BaseEnv = z.output<typeof baseEnvSchema>;
export type WebEnv = z.output<typeof webEnvSchema>;
export type PublicEnv = z.output<typeof publicEnvSchema>;
export type BotEnv = z.output<typeof botEnvSchema>;

/* -------------------------------------------------------------------------- */
/* Loader                                                                      */
/* -------------------------------------------------------------------------- */

/** Raw environment source — anything key/value shaped, `process.env` by default. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  • ${name}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Validate `source` against `schema`, or throw a `ConfigurationError` listing
 * every problem at once.
 *
 * @param schema - The schema for the current runtime.
 * @param source - Raw variables. Defaults to `process.env`.
 * @param label  - Name used in the error message, e.g. `"apps/bot"`.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: EnvSource = process.env,
  label = 'environment',
): Readonly<z.output<TSchema>> {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new ConfigurationError(
      `Invalid ${label} configuration:\n${formatIssues(result.error)}\n\n` +
        'Copy .env.example to .env and fill in the missing values, then re-run `pnpm run check:env`.',
      { cause: result.error, details: { label } },
    );
  }

  return Object.freeze(result.data);
}

/** Memoise a loader so validation runs once per process, not per import. */
function once<T>(load: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: load() }).value;
}

export const loadWebEnv = once(() => parseEnv(webEnvSchema, process.env, 'apps/web'));
export const loadBotEnv = once(() => parseEnv(botEnvSchema, process.env, 'apps/bot'));

/**
 * Public env for the browser.
 *
 * `NEXT_PUBLIC_*` values are inlined by the bundler, so they must be referenced
 * as full static property accesses rather than looked up dynamically.
 */
export const loadPublicEnv = once(() =>
  parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL }, 'public'),
);

export function isProduction(env: BaseEnv): boolean {
  return env.NODE_ENV === 'production';
}

export function isDevelopment(env: BaseEnv): boolean {
  return env.NODE_ENV === 'development';
}

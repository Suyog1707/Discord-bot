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

import { LIMITS, SNOWFLAKE_PATTERN } from '../constants/index.js';
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

/**
 * Enforce variables that are optional in development but mandatory in production.
 *
 * Redis and Lavalink are infrastructure a developer may not want running just to
 * work on the dashboard or a slash command, so they may be omitted locally and
 * the apps degrade gracefully. In production they are not optional: a missing
 * value here is a deployment that silently loses caching, rate limiting or
 * playback, so it is rejected at boot instead.
 *
 * Reported per field, alongside every other problem, in one message.
 */
function requireInProduction<TShape extends z.ZodRawShape>(
  schema: z.ZodObject<TShape>,
  keys: readonly Extract<keyof TShape, string>[],
) {
  return schema.superRefine((value, ctx) => {
    const parsed = value as Record<string, unknown>;
    if (parsed.NODE_ENV !== 'production') return;

    for (const key of keys) {
      if (parsed[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when NODE_ENV=production.`,
        });
      }
    }
  });
}

/** Present in every runtime. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
});

/** PostgreSQL. Required in every environment — the apps are database-backed. */
export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required.')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string.',
    ),
  /**
   * Session connection used by Prisma Migrate and Studio only — never by a
   * running app, which is why it stays optional here. DDL, advisory locks and
   * the shadow database do not work through a transaction pooler, so
   * DATABASE_URL cannot serve both roles. Validated for shape when present so a
   * typo surfaces at `check:env` instead of halfway through a deploy.
   */
  DIRECT_URL: optional(
    z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'DIRECT_URL must be a PostgreSQL connection string.',
      ),
  ),
});

/** Redis. Optional in development, required in production (see `requireInProduction`). */
export const redisEnvSchema = z.object({
  REDIS_URL: optional(
    z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'REDIS_URL must start with redis:// or rediss://.',
      ),
  ),
});

/** Dashboard (`apps/web`) — server side only. */
export const webEnvSchema = requireInProduction(
  baseEnvSchema
    .extend(databaseEnvSchema.shape)
    .extend(redisEnvSchema.shape)
    .extend({
      NEXT_PUBLIC_APP_URL: url,
      NEXTAUTH_URL: url,
      NEXTAUTH_SECRET: z
        .string()
        .min(
          32,
          'NEXTAUTH_SECRET must be at least 32 characters. Generate: openssl rand -base64 32',
        ),
      DISCORD_CLIENT_ID: snowflake,
      DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required.'),
      /** Spotify integration — optional; linking/import stay hidden without it. */
      SPOTIFY_CLIENT_ID: optional(z.string().min(1)),
      SPOTIFY_CLIENT_SECRET: optional(z.string().min(1)),
      SPOTIFY_REDIRECT_URI: optional(z.url()),
    }),
  ['REDIS_URL'],
);

/** Values safe to expose to the browser bundle. Keep this list minimal. */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: url,
});

/** Bot (`apps/bot`). */
export const botEnvSchema = requireInProduction(
  baseEnvSchema
    .extend(databaseEnvSchema.shape)
    .extend(redisEnvSchema.shape)
    .extend({
      BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required.'),
      BOT_CLIENT_ID: snowflake,
      BOT_PUBLIC_KEY: z.string().min(1, 'BOT_PUBLIC_KEY is required.'),
      /** Register slash commands to one guild for instant iteration during development. */
      BOT_DEV_GUILD_ID: optional(snowflake),
      /** Lavalink — optional in development, required in production. */
      LAVALINK_HOST: optional(z.string().min(1)),
      LAVALINK_PORT: port.default(2333),
      LAVALINK_PASSWORD: optional(z.string().min(1)),
      LAVALINK_SECURE: booleanish.default(false),
      /** Spotify Web API (client credentials) for URL metadata. Optional. */
      SPOTIFY_CLIENT_ID: optional(z.string().min(1)),
      SPOTIFY_CLIENT_SECRET: optional(z.string().min(1)),
      /** Runtime playlist expansion is capped by the guild queue capacity. */
      SPOTIFY_PLAYLIST_MAX_TRACKS: z.coerce
        .number()
        .int()
        .min(1)
        .max(LIMITS.QUEUE_MAX_TRACKS)
        .default(LIMITS.QUEUE_MAX_TRACKS),
      /** Bounded parallel Lavalink searches for Spotify collection playback. */
      SPOTIFY_RESOLVE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(8),
      /**
       * Same value as the web app's NEXTAUTH_SECRET. Lets the bot decrypt the
       * Spotify tokens the dashboard stored, enabling `/spotify playlists`.
       * Optional — without it those commands point at the dashboard instead.
       */
      NEXTAUTH_SECRET: optional(z.string().min(32)),
      /** Public dashboard URL for links in bot replies (controller, /spotify connect). */
      DASHBOARD_URL: optional(url),

      /* ---------------------------------------------------------------- */
      /* AI + recommendations                                              */
      /*                                                                   */
      /* Every one of these is optional on purpose. The recommendation      */
      /* stack degrades service by service: no Groq means natural-language  */
      /* requests fall back to the existing keyword parser, no Last.fm      */
      /* means candidates come from history and search instead of the       */
      /* similarity graph. Playback never depends on any of them.          */
      /* ---------------------------------------------------------------- */

      /** Groq — fast intent parsing. Without it `/ask` uses the heuristic parser. */
      GROQ_API_KEY: optional(z.string().min(1)),
      /**
       * Groq model id. The latency here is user-facing — someone is waiting on
       * a slash command — so this wants the strongest model Groq serves at
       * conversational speed.
       *
       * Was `llama-3.3-70b-versatile` until Groq decommissioned it; the API
       * then answered every request with 404 "does not exist or you do not have
       * access to it" and every intent parse silently fell back to the
       * heuristic parser. Groq retires model ids on its own schedule, so when
       * that warning reappears in the logs, check
       * https://console.groq.com/docs/deprecations and move this default on.
       */
      GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
      /**
       * How much of the token budget a reasoning model may spend thinking
       * before it answers.
       *
       * Reasoning models bill their private reasoning against the same
       * `max_tokens` as the reply, so an unconstrained one can think its way
       * through the entire budget and return an empty completion. `low` is the
       * default because intent parsing is a short extraction task with a
       * user waiting on it, not a problem that rewards deliberation.
       *
       * Set this to an empty string for a model that has no reasoning mode:
       * Groq rejects the parameter outright with a 400 rather than ignoring
       * it, so it has to be omitted rather than merely turned down.
       */
      GROQ_REASONING_EFFORT: z.preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? 'none' : value),
        z.enum(['none', 'low', 'medium', 'high']).default('low'),
      ),
      /** Hard ceiling on one intent parse. Past this the heuristic parser wins anyway. */
      GROQ_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(6_000),

      /** Last.fm API key — the similar-tracks / tags discovery signal. */
      LASTFM_API_KEY: optional(z.string().min(1)),

      /**
       * MusicBrainz needs no key, so this exists only as a kill switch: it is
       * rate-limited to one request per second and a heavily-loaded bot may
       * prefer local normalisation alone.
       */
      MUSICBRAINZ_ENABLED: booleanish.default(true),

      /** Candidate pool size per recommendation pass, before ranking and trimming. */
      RECOMMENDATION_POOL_SIZE: z.coerce.number().int().min(20).max(2_000).default(400),
      /** Bounded parallelism for turning ranked candidates into playable tracks. */
      RECOMMENDATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
      /**
       * Autoplay keeps this many vetted tracks ready before the current one
       * ends. Small by design (Smart-Shuffle-style just-in-time batches): each
       * batch is regenerated from the taste anchors plus fresh feedback, and a
       * large buffer would lock in picks made before that feedback existed.
       */
      AUTOPLAY_PREFETCH_SIZE: z.coerce.number().int().min(1).max(50).default(2),
    }),
  ['REDIS_URL', 'LAVALINK_HOST', 'LAVALINK_PASSWORD'],
);

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

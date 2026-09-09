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

      /* ---------------------------------------------------------------- */
      /* The command router                                                */
      /*                                                                   */
      /* Discord posts every interaction to this app rather than down the  */
      /* bot's gateway connection, so the dashboard now holds two          */
      /* credentials that used to belong only to the bot.                  */
      /* ---------------------------------------------------------------- */

      /**
       * The command application's public key, for checking Discord's
       * signature on every request.
       *
       * Without it anybody who finds the endpoint could make the bot say
       * anything, so the route refuses to serve at all when it is unset —
       * optional here only because the dashboard runs perfectly well without
       * the router while it is being brought up.
       */
      BOT_PUBLIC_KEY: optional(z.string().min(1)),
      /**
       * A bot token, used for exactly one call: asking Discord which voice
       * channel the caller is standing in.
       *
       * The interaction payload does not carry it and there is no other way to
       * find out, so routing needs a token from a bot that is in the guild.
       * This is a real widening of what a Vercel compromise would reach — see
       * docs/SECURITY.md — and the reason it is only ever used for that one
       * read.
       */
      BOT_TOKEN: optional(z.string().min(1)),
      /**
       * How long a room must sit empty before another channel may take its
       * player.
       *
       * Duplicated from the bot's own setting for as long as both allocate.
       * Once the router is the only allocator the bot's copy goes away; until
       * then the two should be set to the same value.
       */
      ROOM_RECLAIM_GRACE_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
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
      /**
       * Which application this container is, and what it does.
       *
       * `primary` owns the slash commands, the guards and the dashboard
       * command bus — and plays as well, so a server that only ever needs one
       * room still invites one bot. A `player` is headless: it holds a voice
       * channel and answers intents, nothing else.
       *
       * There is deliberately no fleet count anywhere. Each container
       * registers itself in `player_bots` on startup, so the system learns its
       * roster rather than being told a number.
       */
      BOT_ROLE: z.enum(['primary', 'player']).default('primary'),
      /** Short name for logs, the roster and the invite prompt, e.g. "player-2". */
      BOT_LABEL: z.string().min(1).max(32).default('main'),
      /**
       * Port for the container's private HTTP surface (health, and later the
       * calls siblings make to each other).
       *
       * Bound inside the container and never published, so every player can
       * use the same number — they are reached by service name, not by port.
       */
      BOT_INTERNAL_PORT: port.default(8080),
      /**
       * How long a container may sit disconnected before it quits.
       *
       * Docker restarts containers that crash, not ones that are alive and
       * wedged — so a bot whose gateway has gone and not come back ends itself
       * and lets the restart policy give it a fresh connection. Generous on
       * purpose: discord.js reconnects on its own, and a threshold shorter
       * than its backoff would restart a bot that was about to recover. Zero
       * disables it.
       */
      BOT_UNHEALTHY_EXIT_AFTER_MS: z.coerce.number().int().min(0).max(3_600_000).default(120_000),
      /** How often that check runs. */
      BOT_HEALTH_CHECK_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
      /**
       * How often a container republishes its presence entry.
       *
       * Presence is what tells the allocator which players are running and
       * where to reach them. The entry expires on its own, so this is also
       * what keeps a live player in the fleet — comfortably more often than
       * the expiry, so one missed write costs nothing.
       */
      BOT_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(20_000),
      /**
       * How long a room must sit empty before another channel may take its
       * player.
       *
       * Long enough to survive everyone moving between channels together,
       * short enough that a genuinely abandoned room is not held for a
       * noticeable time.
       */
      ROOM_RECLAIM_GRACE_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
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

      /* ---------------------------------------------------------------- */
      /* Track resolution                                                  */
      /*                                                                   */
      /* The metadata layer (Spotify / Apple Music / Deezer) identifies    */
      /* the recording; the playback layer (SoundCloud / YouTube / HTTP)   */
      /* finds an upload that IS it. These tune the second half — see      */
      /* music/match-config.ts for what each weight actually does.         */
      /* ---------------------------------------------------------------- */

      /**
       * Playback provider priority. SoundCloud first by design: its catalogue
       * is only music, so its worst wrong answer is a bootleg remix, whereas
       * YouTube's index holds the film the song is from and everything anyone
       * ever said about it. Flip this to fall back the other way without a
       * deploy when SoundCloud coverage is the bigger problem for a workload.
       */
      PLAYBACK_PROVIDER_ORDER: z
        .enum(['soundcloud,youtube', 'youtube,soundcloud', 'soundcloud', 'youtube'])
        .default('soundcloud,youtube'),
      /**
       * How far a candidate's runtime may sit from the canonical runtime and
       * still count as a match. The ±10-15s band covers fade-outs, silent tails
       * and the half-second disagreements between catalogues; widen it for
       * catalogues that habitually pad, and never so far that a 6-minute
       * picturised cut passes for a 3:48 song.
       */
      MATCH_DURATION_TOLERANCE_MS: z.coerce.number().int().min(1_000).max(120_000).default(12_000),
      /**
       * Minimum score a SoundCloud candidate must reach before it is played.
       *
       * Higher than YouTube's on purpose: whatever SoundCloud refuses is asked
       * of YouTube, where the official Topic and VEVO uploads are, so a
       * demanding primary costs latency rather than coverage.
       */
      MATCH_SOUNDCLOUD_MIN_SCORE: z.coerce.number().int().min(0).max(200).default(70),
      /**
       * Minimum score a YouTube candidate must reach. Lower than SoundCloud's
       * because there is nothing after it — below this, nothing plays at all.
       */
      MATCH_YOUTUBE_MIN_SCORE: z.coerce.number().int().min(0).max(200).default(55),
      /**
       * Extra uploader-name tokens that mark a rights-holder, comma-separated.
       *
       * The built-in list is generic ("records", "recordings", "label") rather
       * than a roster of company names, because a fixed roster is wrong the
       * moment the bot plays music from a market nobody listed. This is where
       * an operator adds the labels that matter to their listeners.
       */
      MATCH_OFFICIAL_CHANNELS: optional(z.string().min(1)),
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
      /**
       * How many familiar songs autoplay plays between discoveries.
       *
       * A range rather than a fixed number on purpose: the planner picks the
       * high end when the listener's own pool (library, playlists, history)
       * is deep, and the low end when it is thin, so the radio adapts instead
       * of marching to a fixed "two known, one new" beat. MIN is clamped to
       * MAX at read time if an operator inverts them.
       */
      AUTOPLAY_FAMILIAR_RUN_MIN: z.coerce.number().int().min(1).max(6).default(2),
      AUTOPLAY_FAMILIAR_RUN_MAX: z.coerce.number().int().min(1).max(8).default(3),
      /**
       * Whether autoplay introduces discoveries at all. Off means the radio
       * only ever replays what the room already knows — useful for a guild
       * that wants a jukebox, not a recommender.
       */
      AUTOPLAY_DISCOVERY_ENABLED: booleanish.default(true),
      /**
       * Let a listener's linked Spotify library steer autoplay.
       *
       * On, their playlists and Liked Songs join the familiar pool and their
       * artists become a discovery prior — for the people actually in the
       * voice channel, and only where they left the dashboard opt-in on. Off
       * is the pre-Spotify behaviour: autoplay sees only what the bot itself
       * recorded. Reads are cached and never block a queue refill.
       */
      SPOTIFY_TASTE_ENABLED: booleanish.default(true),
      /**
       * Tracks read per listener before their library is truncated. Guards
       * both the Spotify API budget and the size of the familiar pool a single
       * heavy listener can occupy.
       */
      SPOTIFY_TASTE_MAX_TRACKS: z.coerce.number().int().min(20).max(1000).default(200),
      /**
       * Queue refill: autoplay tops the queue up BEFORE it drains. When the
       * upcoming count falls to the low-water mark a refill starts, and it
       * fills back up to the target. Small numbers on purpose: every pick
       * beyond the target was chosen before the feedback that could have
       * changed it.
       */
      AUTOPLAY_LOW_WATER_MARK: z.coerce.number().int().min(1).max(10).default(2),
      AUTOPLAY_TARGET_QUEUE_SIZE: z.coerce.number().int().min(2).max(20).default(4),
      /**
       * How long a song rests before autoplay may bring it back. This is the
       * "intelligent repetition" knob: a favourite from three hours ago is a
       * welcome return, one from ten minutes ago is a bug. Halved (never
       * below 30 minutes) only when the pool would otherwise be empty.
       */
      AUTOPLAY_REPEAT_COOLDOWN_MINUTES: z.coerce.number().int().min(15).max(1440).default(180),
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

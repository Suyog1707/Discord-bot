/** Cross-app constants. Anything both `apps/web` and `apps/bot` must agree on lives here. */

export const APP_NAME = 'Discord Music Platform';

/** Discord snowflakes are 17–20 digit numeric strings. */
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/u;

/** Queue / playlist limits, enforced identically on the dashboard and in the bot. */
export const LIMITS = {
  /** Tracks a single guild queue may hold. */
  QUEUE_MAX_TRACKS: 1000,
  /** Tracks a single playlist may hold. */
  PLAYLIST_MAX_TRACKS: 500,
  /** Playlists a free-tier user may own. */
  PLAYLIST_MAX_PER_USER: 25,
  /** Playlists a premium user may own. */
  PLAYLIST_MAX_PER_PREMIUM_USER: 250,
  PLAYLIST_NAME_MIN_LENGTH: 1,
  PLAYLIST_NAME_MAX_LENGTH: 100,
  PLAYLIST_DESCRIPTION_MAX_LENGTH: 500,
  /** Search results returned to a user in one response. */
  SEARCH_RESULTS_MAX: 25,
  /** Default and maximum page sizes for paginated API responses. */
  PAGE_SIZE_DEFAULT: 20,
  PAGE_SIZE_MAX: 100,
  /** Playback volume bounds, in percent. */
  VOLUME_MIN: 0,
  VOLUME_MAX: 200,
  VOLUME_DEFAULT: 100,
} as const;

/** Redis key namespaces. Always build keys through `redisKey` to avoid collisions. */
export const REDIS_NAMESPACE = {
  RATE_LIMIT: 'ratelimit',
  SESSION: 'session',
  QUEUE: 'queue',
  PLAYER: 'player',
  CACHE: 'cache',
  LOCK: 'lock',
} as const;

export type RedisNamespace = (typeof REDIS_NAMESPACE)[keyof typeof REDIS_NAMESPACE];

/** Build a namespaced Redis key: `dmp:<namespace>:<part>:<part>`. */
export function redisKey(namespace: RedisNamespace, ...parts: readonly string[]): string {
  return ['dmp', namespace, ...parts].join(':');
}

/** Cache time-to-live values, in seconds. */
export const CACHE_TTL_SECONDS = {
  SHORT: 30,
  MEDIUM: 5 * 60,
  LONG: 60 * 60,
  DAY: 24 * 60 * 60,
} as const;

/** Music sources supported by Lavalink (docs/MUSIC_SYSTEM.md). */
export const MUSIC_SOURCES = ['youtube', 'spotify', 'soundcloud', 'deezer'] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

export const LOOP_MODES = ['off', 'track', 'queue'] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

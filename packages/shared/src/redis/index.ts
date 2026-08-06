/**
 * Redis connection factory (ioredis).
 *
 * Works against a local container in development and Upstash in production
 * (docs/DEPLOYMENT.md) — a `rediss://` URL enables TLS automatically.
 *
 * Consumers used across hot-reloads (Next.js dev) should use
 * `getSharedRedis()` so a module reload does not open a new socket each time.
 */
import { Redis, type RedisOptions } from 'ioredis';

import { UpstreamError } from '../errors/index.js';
import type { Logger } from '../logger/index.js';

export type { Redis, RedisOptions };

type SocketError = Error & {
  code?: string;
  address?: string;
  port?: number;
  errors?: readonly unknown[];
};

/**
 * Reduce a socket error to the fields that identify it.
 *
 * Node reports a refused connection as an `AggregateError` whose own `address`
 * and `port` are undefined — those live on the individual attempts — so the
 * first sub-error is used to fill them in.
 */
function summarizeConnectionError(error: Error): Record<string, unknown> {
  const socketError = error as SocketError;
  const [firstAttempt] = (socketError.errors ?? []) as SocketError[];
  const detail = socketError.address === undefined ? firstAttempt : socketError;

  return {
    code: socketError.code ?? error.name,
    address: detail?.address,
    port: detail?.port,
    // AggregateError carries an empty message; fall back to the first attempt.
    reason: error.message || firstAttempt?.message,
  };
}

export interface CreateRedisOptions {
  readonly url: string;
  /** Logger for connection lifecycle events. */
  readonly logger?: Logger;
  /** Prefix applied to every key by ioredis. Usually left unset — see `redisKey`. */
  readonly keyPrefix?: string;
  /** Additional ioredis options, merged last. */
  readonly options?: RedisOptions;
}

/**
 * Create a Redis client with production-safe defaults: capped exponential
 * backoff, no unbounded offline queue, and lazy connect so construction never
 * throws.
 */
export function createRedisClient({ url, logger, keyPrefix, options }: CreateRedisOptions): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    // Fail fast instead of buffering commands forever while disconnected.
    enableOfflineQueue: false,
    connectTimeout: 10_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
    ...options,
  });

  if (logger) {
    client.on('connect', () => {
      logger.debug('Redis connecting');
    });
    client.on('ready', () => {
      logger.info('Redis ready');
    });
    client.on('reconnecting', (delay: number) => {
      logger.debug({ delay }, 'Redis reconnecting');
    });
    client.on('end', () => {
      logger.debug('Redis connection closed');
    });
    /**
     * A listener is mandatory: without one, ioredis emits an unhandled 'error'
     * and takes the process down.
     *
     * Logged as a compact summary rather than the full object. A refused
     * connection arrives as an `AggregateError` holding one entry per resolved
     * address (IPv6 and IPv4), so logging it whole prints several near-identical
     * stacks made entirely of internal `node:net` frames — no signal, and it
     * buries the actionable warning the caller emits a moment later.
     */
    client.on('error', (error: Error) => {
      logger.warn(summarizeConnectionError(error), 'Redis connection error');
    });
  } else {
    client.on('error', () => {
      /* Swallowed: no logger supplied. Failures surface at the call site. */
    });
  }

  return client;
}

/**
 * Process-wide singleton, cached on `globalThis` so Next.js hot-reloads and
 * repeated imports reuse one connection pool.
 */
// Typed as `unique symbol` so the property below stays optional rather than
// collapsing into a `[key: symbol]` index signature.
const REDIS_SINGLETON_KEY: unique symbol = Symbol.for('discord-music.redis');

type RedisGlobal = typeof globalThis & { [REDIS_SINGLETON_KEY]?: Redis };

export function getSharedRedis(options: CreateRedisOptions): Redis {
  const scope = globalThis as RedisGlobal;

  const existing = scope[REDIS_SINGLETON_KEY];
  if (existing) return existing;

  const client = createRedisClient(options);
  scope[REDIS_SINGLETON_KEY] = client;
  return client;
}

/** Connect and verify with `PING`, converting failures into an `UpstreamError`. */
export async function connectRedis(client: Redis): Promise<Redis> {
  try {
    if (client.status === 'end' || client.status === 'wait') {
      await client.connect();
    }
    await client.ping();
    return client;
  } catch (error) {
    throw new UpstreamError('Could not connect to Redis.', { cause: error });
  }
}

/** Close the connection gracefully, falling back to a hard disconnect. */
export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

import 'server-only';

/**
 * Request rate limiting (docs/SECURITY.md).
 *
 * Fixed-window counter: INCR + EXPIRE in Redis when configured (shared across
 * instances), an in-memory map otherwise (still protects a single instance,
 * which is exactly the development topology). Throws `RateLimitError` so the
 * API error handler emits 429 + Retry-After.
 */
import { RateLimitError, REDIS_NAMESPACE, redisKey } from '@discord-music/shared';

import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

interface WindowState {
  count: number;
  resetAtMs: number;
}

const memoryWindows = new Map<string, WindowState>();
let lastPruneMs = 0;

function pruneMemory(nowMs: number): void {
  if (nowMs - lastPruneMs < 60_000) return;
  lastPruneMs = nowMs;
  for (const [key, state] of memoryWindows) {
    if (state.resetAtMs <= nowMs) memoryWindows.delete(key);
  }
}

export interface RateLimitOptions {
  /** Stable identity for the caller: user id, or IP for anonymous routes. */
  readonly identity: string;
  /** Logical bucket, usually the route name. */
  readonly bucket: string;
  /** Max requests per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Count one request; throw `RateLimitError` when over the limit. */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const { identity, bucket, limit, windowSeconds } = options;
  const key = redisKey(REDIS_NAMESPACE.RATE_LIMIT, bucket, identity);
  const redis = getRedis();

  if (redis !== undefined) {
    try {
      // Single atomic script: INCR + EXPIRE cannot be two round trips — a
      // failure between them would leave a counter with no TTL, permanently
      // rate-limiting the user. The TTL<0 branch also self-heals any key
      // orphaned by an older code path.
      const [count, ttl] = (await redis.eval(
        `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`,
        1,
        key,
        windowSeconds,
      )) as [number, number];

      if (count > limit) {
        throw new RateLimitError(Math.max(ttl, 1));
      }
      return;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      // Redis degraded: protect with the local window rather than failing open
      // silently or closing the endpoint entirely.
      getLogger('rate-limit').warn({ err: error }, 'Rate limit fell back to memory');
    }
  }

  const nowMs = Date.now();
  pruneMemory(nowMs);

  const state = memoryWindows.get(key);
  if (state === undefined || state.resetAtMs <= nowMs) {
    memoryWindows.set(key, { count: 1, resetAtMs: nowMs + windowSeconds * 1000 });
    return;
  }

  state.count += 1;
  if (state.count > limit) {
    throw new RateLimitError(Math.max(Math.ceil((state.resetAtMs - nowMs) / 1000), 1));
  }
}

/** Sensible defaults per kind of endpoint. */
export const RATE_LIMITS = {
  /** Reads: generous. */
  read: { limit: 60, windowSeconds: 60 },
  /** Writes/mutations: tighter. */
  write: { limit: 20, windowSeconds: 60 },
  /** Player controls: rapid clicking is expected, but bounded. */
  control: { limit: 30, windowSeconds: 60 },
} as const;

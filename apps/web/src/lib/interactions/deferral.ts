import 'server-only';

/**
 * Deciding whether a command's reply is public, before running it.
 *
 * The router acknowledges every interaction on the bot's behalf, and Discord
 * fixes visibility at that moment — a reply deferred privately can never
 * become public. So this has to be answered in the few hundred milliseconds
 * before the acknowledgement goes out, from raw JSON, with no discord.js.
 *
 * The answer comes from a manifest the primary publishes on startup. That
 * indirection exists because this app cannot import the command modules: they
 * pull in discord.js, Lavalink and Prisma. A missing manifest costs the
 * default, which is the safe one — so a cold Redis degrades to "everything is
 * private", not to broken commands.
 */
import {
  DEFAULT_DEFERRAL,
  DEFERRAL_MANIFEST_KEY,
  decodeDeferralManifest,
  rawSubcommandName,
  resolveDeferral,
  type DeferralManifest,
  type DeferralMode,
} from '@discord-music/shared';

import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

/**
 * Cached for the life of the instance.
 *
 * It changes only when a command's declaration changes, which means a deploy,
 * which means new instances. The TTL is belt and braces for a long-lived one.
 */
const CACHE_TTL_MS = 60_000;

let cache: { readonly value: DeferralManifest; readonly expiresAt: number } | undefined;

async function loadManifest(): Promise<DeferralManifest> {
  if (cache !== undefined && cache.expiresAt > Date.now()) return cache.value;

  const redis = getRedis();
  if (redis === undefined) return {};

  try {
    const raw = await redis.get(DEFERRAL_MANIFEST_KEY);
    const value = raw === null ? {} : (decodeDeferralManifest(raw) ?? {});
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch (error) {
    getLogger('interactions').warn(
      { err: error },
      'Deferral manifest unreadable; defaulting to ephemeral',
    );
    return cache?.value ?? {};
  }
}

/**
 * How to acknowledge this particular invocation.
 *
 * The one piece of I/O on the path before Discord is answered, which is why it
 * is a single cached `GET` and nothing more.
 */
export async function deferralFor(payload: unknown): Promise<DeferralMode> {
  const data = (payload as { readonly data?: { readonly name?: unknown } } | null)?.data;
  const commandName = typeof data?.name === 'string' ? data.name : null;
  if (commandName === null) return DEFAULT_DEFERRAL;

  const manifest = await loadManifest();
  return resolveDeferral(manifest[commandName], rawSubcommandName(data));
}

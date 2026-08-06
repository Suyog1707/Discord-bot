import 'server-only';

/**
 * Discord REST client for the dashboard, acting *as the signed-in user*.
 *
 * Token lifecycle (docs/AUTHENTICATION.md: refresh tokens):
 * - Access + refresh tokens are stored on the Account row by the Auth.js
 *   adapter at sign-in.
 * - `getValidAccessToken` refreshes ahead of expiry (60s skew), persists the
 *   rotated pair, and revokes nothing — Discord rotates refresh tokens on use.
 * - A failed refresh throws `UnauthenticatedError`, which the API layer maps
 *   to 401 so the client knows to re-authenticate.
 */
import {
  UnauthenticatedError,
  UpstreamError,
  RateLimitError,
  CACHE_TTL_SECONDS,
  REDIS_NAMESPACE,
  redisKey,
} from '@discord-music/shared';

import { canManageGuild } from '@/lib/discord/permissions';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_URL = `${DISCORD_API}/oauth2/token`;
/** Refresh this many milliseconds before the recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

export interface DiscordGuildSummary {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly owner: boolean;
  /** Permission bitfield as a decimal string. */
  readonly permissions: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: string;
  readonly scope: string;
}

/**
 * Return a currently valid access token for the user, refreshing if needed.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const db = getDb();
  const account = await db.account.findFirst({
    where: { userId, provider: 'discord' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });

  if (account?.access_token == null) {
    throw new UnauthenticatedError('Your Discord session is missing. Please sign in again.');
  }

  const expiresAtMs = (account.expires_at ?? 0) * 1000;
  if (expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
    return account.access_token;
  }

  if (account.refresh_token == null) {
    throw new UnauthenticatedError('Your Discord session has expired. Please sign in again.');
  }

  const env = getEnv();
  const logger = getLogger('discord-api');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });

  if (!response.ok) {
    // A rejected refresh token is unrecoverable server-side; the user must
    // sign in again. 4xx here means revoked/rotated-away, 5xx is Discord down.
    if (response.status >= 500) {
      throw new UpstreamError('Discord is unavailable. Please try again shortly.');
    }
    logger.warn({ userId, status: response.status }, 'Discord token refresh rejected');
    throw new UnauthenticatedError('Your Discord session has expired. Please sign in again.');
  }

  const token = (await response.json()) as TokenResponse;

  await db.account.update({
    where: { id: account.id },
    data: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
      token_type: token.token_type,
      scope: token.scope,
    },
  });

  logger.debug({ userId }, 'Discord access token refreshed');
  return token.access_token;
}

/** GET against the Discord API as the user, with typed error mapping. */
async function discordFetch<T>(userId: string, path: string): Promise<T> {
  const accessToken = await getValidAccessToken(userId);

  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // Discord guild lists change rarely; our own Redis cache handles reuse.
    cache: 'no-store',
  });

  if (response.status === 401) {
    throw new UnauthenticatedError('Your Discord session has expired. Please sign in again.');
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After') ?? '5');
    throw new RateLimitError(Number.isFinite(retryAfter) ? retryAfter : 5);
  }
  if (!response.ok) {
    throw new UpstreamError(`Discord API request failed (${String(response.status)}).`);
  }

  return (await response.json()) as T;
}

/**
 * Guilds the user belongs to, cached briefly in Redis (when available) to
 * stay clear of Discord's strict per-user rate limit on this endpoint.
 */
export async function fetchUserGuilds(userId: string): Promise<readonly DiscordGuildSummary[]> {
  const cacheKey = redisKey(REDIS_NAMESPACE.CACHE, 'user-guilds', userId);
  const redis = getRedis();

  if (redis !== undefined) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as DiscordGuildSummary[];
    } catch {
      // Cache is an optimisation; fall through to the API on any Redis error.
    }
  }

  const guilds = await discordFetch<DiscordGuildSummary[]>(userId, '/users/@me/guilds');
  const summary = guilds.map(({ id, name, icon, owner, permissions }) => ({
    id,
    name,
    icon,
    owner,
    permissions,
  }));

  if (redis !== undefined) {
    try {
      await redis.set(cacheKey, JSON.stringify(summary), 'EX', CACHE_TTL_SECONDS.SHORT);
    } catch {
      // Same: never let the cache break the request.
    }
  }

  return summary;
}

/** Guilds the user can manage on the dashboard (owner, admin, or Manage Server). */
export async function fetchManageableGuilds(
  userId: string,
): Promise<readonly DiscordGuildSummary[]> {
  const guilds = await fetchUserGuilds(userId);
  return guilds.filter((guild) => canManageGuild(guild.permissions, guild.owner));
}

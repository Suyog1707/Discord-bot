import 'server-only';

/**
 * The three sources routing reads, gathered from a process with no Discord
 * connection of its own.
 *
 * The bot answers "which players exist and what are they doing?" partly from
 * its own gateway cache. The router cannot: it has never spoken to Discord and
 * holds no players. Everything it knows comes from Postgres and Redis, which
 * is exactly why those two were made the source of truth in the first place.
 */
import {
  buildFleet,
  PLAYER_BOT_STALE_MS,
  playerRoomOwnerKey,
  type FleetView,
} from '@discord-music/shared';
import { readLiveBots } from '@discord-music/shared/redis';

import { getDb } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

/**
 * Redis is unreachable, as distinct from "no bot is running".
 *
 * Worth its own type because conflating the two produces a specific, bad lie:
 * an empty fleet reads as `full`, and the caller is told every player is busy
 * when in fact nothing was ever asked. They then go and look at the bots.
 */
export class FleetUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The fleet could not be read.', { cause });
    this.name = 'FleetUnavailableError';
  }
}

export interface FleetSnapshot {
  readonly fleet: FleetView;
  /** Who already holds the caller's channel, from the owner claim. */
  readonly ownerBotId: string | null;
}

/**
 * Everything the routing decision needs, in as few round trips as possible.
 *
 * The reads do not depend on each other, so they go out together: the cost is
 * the slowest of them rather than their sum. Worth doing even though the work
 * happens after Discord has been answered — this runs inside a metered
 * function, and a second saved is a second not billed.
 */
export async function readFleet(
  guildId: string,
  voiceChannelId: string | null,
): Promise<FleetSnapshot> {
  const redis = getRedis();
  if (redis === undefined) throw new FleetUnavailableError('REDIS_URL is not configured');

  const db = getDb();

  try {
    const [roster, invited, presence, owner] = await Promise.all([
      db.playerBot.findMany({
        orderBy: { createdAt: 'asc' },
        select: { label: true, clientId: true },
      }),
      db.guildBot.findMany({
        where: { guild: { discordId: guildId }, present: true },
        select: { botClientId: true },
      }),
      readLiveBots(redis),
      voiceChannelId === null
        ? Promise.resolve(null)
        : redis.get(playerRoomOwnerKey(guildId, voiceChannelId)),
    ]);

    const fleet = buildFleet({
      roster: roster.map((row) => ({ botId: row.label, clientId: row.clientId })),
      invited: new Set(invited.map((row) => row.botClientId)),
      presence,
      // The router holds no reservations of its own; outstanding claims are
      // read back from Redis by the caller and folded in there.
      claims: new Map(),
      guildId,
      now: Date.now(),
      staleAfterMs: PLAYER_BOT_STALE_MS,
    });

    return { fleet, ownerBotId: ownerBotIdOf(owner) };
  } catch (error) {
    getLogger('interactions').error({ err: error, guildId }, 'Fleet read failed');
    throw new FleetUnavailableError(error);
  }
}

/** The owner claim is `{ botId, baseUrl }`; only the id matters here. */
function ownerBotIdOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { readonly botId?: unknown };
    return typeof parsed.botId === 'string' ? parsed.botId : null;
  } catch {
    return null;
  }
}

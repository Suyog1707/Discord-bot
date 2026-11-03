/**
 * What routing knows about the fleet, read from the primary.
 *
 * The same reads the web router does (apps/web/src/lib/interactions/fleet.ts),
 * for the same reason: the Redis presence entries are the one picture of
 * "who is running and what are they holding" that every process agrees on,
 * and a second reading of it would be a second opinion. The difference is the
 * fallback. The web router has to open a database client to fill gaps; the
 * primary already owns one, through `GuildService`.
 */
import {
  buildFleet,
  PLAYER_BOT_STALE_MS,
  rosterFromPresence,
  type BotPresence,
  type FleetView,
} from '@discord-music/shared';
import { readBotIds, readGuildFleet, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';
import type { FleetSource } from '../music/player-router.js';

/**
 * Redis is unreachable, as distinct from "no bot is running".
 *
 * Conflating the two produces a specific, bad lie: an empty fleet reads as
 * `full`, and the caller is told every player is busy when nothing was ever
 * asked.
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
  /** The live bots, so a second look at the roster need not read them again. */
  readonly presence: readonly BotPresence[];
}

/** Everything the routing decision needs, in one Redis round trip. */
export async function readGatewayFleet(
  redis: Redis,
  roster: FleetSource,
  guildId: string,
  voiceChannelId: string | null,
): Promise<FleetSnapshot> {
  try {
    const read = await readGuildFleet(redis, await readBotIds(redis), guildId, voiceChannelId);
    const ownerBotId = ownerBotIdOf(read.owner);

    const inGuild = read.inGuild;
    // A live bot that has not published its server list yet: only the roster
    // can say which servers it is in.
    if (inGuild === undefined) {
      return {
        fleet: await fleetFromRoster(roster, guildId, read.presence),
        ownerBotId,
        presence: read.presence,
      };
    }

    const fleet = buildFleet({
      roster: rosterFromPresence(read.presence),
      invited: new Set(
        read.presence.filter((entry) => inGuild.has(entry.botId)).map((entry) => entry.clientId),
      ),
      presence: read.presence,
      // Claims are made atomically with the hand-over, not folded in here.
      claims: new Map(),
      guildId,
      now: Date.now(),
      staleAfterMs: PLAYER_BOT_STALE_MS,
    });

    return { fleet, ownerBotId, presence: read.presence };
  } catch (error) {
    getLogger('interactions').error({ err: error, guildId }, 'Fleet read failed');
    throw new FleetUnavailableError(error);
  }
}

/**
 * The same fleet, with the roster and invitations from the database.
 *
 * For the moments Redis alone cannot answer: a bot that has not published its
 * server list, and a refusal that should be able to name a stopped player.
 * `GuildService` already returns the roster in hand-out order.
 */
export async function fleetFromRoster(
  roster: FleetSource,
  guildId: string,
  presence: readonly BotPresence[],
): Promise<FleetView> {
  const [bots, invited] = await Promise.all([roster.listBots(), roster.botsInGuild(guildId)]);

  return buildFleet({
    roster: bots.map(({ botId, clientId }) => ({ botId, clientId })),
    invited,
    presence,
    claims: new Map(),
    guildId,
    now: Date.now(),
    staleAfterMs: PLAYER_BOT_STALE_MS,
  });
}

/** The owner claim is `{ botId }`; only the id matters here. */
function ownerBotIdOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { readonly botId?: unknown };
    return typeof parsed.botId === 'string' ? parsed.botId : null;
  } catch {
    return null;
  }
}

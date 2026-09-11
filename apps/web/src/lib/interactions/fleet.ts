import 'server-only';

/**
 * What routing knows about the fleet, from a process with no Discord
 * connection of its own.
 *
 * The router cannot look at a gateway cache: it has never spoken to Discord and
 * holds no players. So it reads what the bots publish about themselves in
 * Redis — who is running, what each is holding, and which servers each is in.
 *
 * Postgres is deliberately off this path. It used to answer "which bots does
 * this server have?" on every command, which meant a database connection (and
 * on a cold start, loading a database client) standing between typing `/play`
 * and a bot hearing about it. It is still read in the two cases Redis cannot
 * answer: a bot too old to publish its server list, and a refusal that needs
 * to name a bot that is not running.
 */
import {
  buildFleet,
  compareRoster,
  PLAYER_BOT_STALE_MS,
  rosterFromPresence,
  type BotPresence,
  type FleetView,
} from '@discord-music/shared';
import { readBotIds, readGuildFleet, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '@/lib/logger';
import { getReadyRedis } from '@/lib/redis';

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
  /** The live bots, so a second look at the roster need not read them again. */
  readonly presence: readonly BotPresence[];
}

/**
 * The index of bot ids, on its own.
 *
 * Separate so the router can send it out alongside Discord's voice-state
 * lookup: the rest of the fleet read needs the caller's channel, this does not.
 */
export async function readFleetIds(): Promise<readonly string[]> {
  const redis = await requireRedis();
  try {
    return await readBotIds(redis);
  } catch (error) {
    getLogger('interactions').error({ err: error }, 'Fleet index read failed');
    throw new FleetUnavailableError(error);
  }
}

/**
 * Everything the routing decision needs, in one Redis round trip.
 *
 * @param ids From {@link readFleetIds}, when the caller already has them.
 */
export async function readFleet(
  guildId: string,
  voiceChannelId: string | null,
  ids?: readonly string[],
): Promise<FleetSnapshot> {
  const redis = await requireRedis();

  try {
    const read = await readGuildFleet(
      redis,
      ids ?? (await readBotIds(redis)),
      guildId,
      voiceChannelId,
    );
    const ownerBotId = ownerBotIdOf(read.owner);

    const inGuild = read.inGuild;
    if (inGuild === undefined) {
      return {
        fleet: await fleetFromDatabase(guildId, read.presence),
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
      // The router holds no reservations of its own; its claims are made
      // atomically with the hand-over, not folded in here.
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
 * The same fleet, with the roster and invitations read from Postgres.
 *
 * For the moments Redis alone cannot answer: a live bot that has not published
 * its server list yet, and a refusal — "add another bot" should be able to name
 * a player that is not running, and only the roster knows those.
 */
export async function fleetFromDatabase(
  guildId: string,
  presence: readonly BotPresence[],
): Promise<FleetView> {
  // Imported here rather than at the top: this is what keeps the database
  // client out of the module graph of every command that never gets this far.
  const { getDb } = await import('@/lib/db');
  const db = getDb();

  const [roster, invited] = await Promise.all([
    db.playerBot.findMany({ select: { label: true, clientId: true, role: true } }),
    db.guildBot.findMany({
      where: { guild: { discordId: guildId }, present: true },
      select: { botClientId: true },
    }),
  ]);

  return buildFleet({
    roster: roster
      .map((row) => ({ botId: row.label, clientId: row.clientId, role: row.role }))
      .sort(compareRoster)
      .map(({ botId, clientId }) => ({ botId, clientId })),
    invited: new Set(invited.map((row) => row.botClientId)),
    presence,
    claims: new Map(),
    guildId,
    now: Date.now(),
    staleAfterMs: PLAYER_BOT_STALE_MS,
  });
}

async function requireRedis(): Promise<Redis> {
  const redis = await getReadyRedis();
  if (redis === undefined) throw new FleetUnavailableError('REDIS_URL is not configured');
  return redis;
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

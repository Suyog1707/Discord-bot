/**
 * Reading which containers are alive, and what they are holding.
 *
 * Two very different processes need this answer: a bot deciding whether it can
 * take a room, and the command router deciding which bot to send a command to.
 * They read the same keys, so they read them through the same code — a second
 * parser would be a second opinion about what a live player is.
 *
 * Node-only (it takes a Redis client), so it lives behind the `/redis` subpath
 * rather than the isomorphic barrel.
 */
import type { BotPresence, RoomState } from '../fleet/index.js';
import {
  PLAYER_BOT_GUILDS_SENTINEL,
  playerBotGuildsKey,
  playerBotIndexKey,
  playerBotKey,
  playerRoomOwnerKey,
} from '../player-events/index.js';

import type { Redis } from './index.js';

/**
 * Parse one presence entry.
 *
 * Hand-written rather than a schema because the entry is written by us, read
 * by us, and read on the hot path of every command — and because the one thing
 * that must not happen is a whole fleet disappearing over a field a newer
 * container started sending. Unknown fields are ignored; missing ones make the
 * entry unusable and it is skipped.
 */
export function parseBotPresence(payload: string): BotPresence | undefined {
  try {
    const parsed = JSON.parse(payload) as Partial<BotPresence>;
    if (typeof parsed.botId !== 'string' || parsed.botId === '') return undefined;
    if (typeof parsed.clientId !== 'string' || parsed.clientId === '') return undefined;

    return {
      botId: parsed.botId,
      clientId: parsed.clientId,
      role: parsed.role === 'player' ? 'player' : 'primary',
      rooms: Array.isArray(parsed.rooms) ? (parsed.rooms as readonly RoomState[]) : [],
      // Absent on an entry written before the field existed. Left absent rather
      // than defaulted, so freshness stays a fact the writer stated.
      ...(typeof parsed.sentAt === 'number' ? { sentAt: parsed.sentAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Every container that has checked in recently.
 *
 * Throws rather than returning `[]` when Redis itself is unreachable. The two
 * are not the same thing and must not be conflated: an empty list means no bot
 * is running, and telling somebody "every player is busy" because a lookup
 * failed is a lie that sends them off to debug the wrong problem.
 *
 * Members whose entry has expired are dropped from the index as they are
 * found, so a player that is retired rather than restarted stops being asked
 * about instead of being asked about forever.
 */
export async function readLiveBots(redis: Redis): Promise<readonly BotPresence[]> {
  const ids = await redis.smembers(playerBotIndexKey());
  if (ids.length === 0) return [];

  const raw = await redis.mget(...ids.map((id) => playerBotKey(id)));
  const live: BotPresence[] = [];
  const gone: string[] = [];

  ids.forEach((id, index) => {
    const payload = raw[index];
    if (payload == null) {
      gone.push(id);
      return;
    }
    const parsed = parseBotPresence(payload);
    if (parsed === undefined) gone.push(id);
    else live.push(parsed);
  });

  // Tidying is best-effort: failing to prune must not fail the read.
  if (gone.length > 0) redis.srem(playerBotIndexKey(), ...gone).catch(() => 0);

  return live;
}

/** Every container id that has ever checked in; the entries say which are live. */
export async function readBotIds(redis: Redis): Promise<readonly string[]> {
  return redis.smembers(playerBotIndexKey());
}

export interface GuildFleetRead {
  /** Live containers, as they describe themselves. */
  readonly presence: readonly BotPresence[];
  /**
   * Which of them are in the server — or undefined when some live bot has not
   * published its server list, which is a container from before the list
   * existed, mid-deploy. The caller should ask Postgres rather than guess.
   */
  readonly inGuild: ReadonlySet<string> | undefined;
  /** The raw owner claim for the caller's channel, or null. */
  readonly owner: string | null;
  /** Ids whose presence entry has expired, for the index to forget. */
  readonly gone: readonly string[];
}

/**
 * Put one pipelined read back together.
 *
 * Pure, so every shape of a half-deployed fleet is a row in a test.
 *
 * @param input.membership Per id, `[listWritten, inThisServer]` as SMISMEMBER
 *   answers it for the sentinel and the server id.
 */
export function assembleGuildFleet(input: {
  readonly ids: readonly string[];
  readonly payloads: readonly (string | null)[];
  readonly membership: readonly (readonly number[] | null | undefined)[];
  readonly owner: string | null;
}): GuildFleetRead {
  const presence: BotPresence[] = [];
  const gone: string[] = [];
  const inGuild = new Set<string>();
  let complete = true;

  // A loop rather than `forEach`, so the compiler can see `complete` change.
  for (const [index, id] of input.ids.entries()) {
    const payload = input.payloads[index];
    const parsed = payload == null ? undefined : parseBotPresence(payload);
    if (parsed === undefined) {
      // A dead container's list says nothing about who can take a command.
      gone.push(id);
      continue;
    }
    presence.push(parsed);

    const [written, member] = input.membership[index] ?? [0, 0];
    if (written !== 1) complete = false;
    else if (member === 1) inGuild.add(parsed.botId);
  }

  return { presence, inGuild: complete ? inGuild : undefined, owner: input.owner, gone };
}

/**
 * Everything routing reads from Redis about one server, in one round trip.
 *
 * `ids` comes from {@link readBotIds}, fetched separately so the router can ask
 * for it alongside Discord's voice-state lookup instead of after it. Throws
 * when Redis cannot answer, for the same reason {@link readLiveBots} does.
 */
export async function readGuildFleet(
  redis: Redis,
  ids: readonly string[],
  guildId: string,
  voiceChannelId: string | null,
): Promise<GuildFleetRead> {
  const pipeline = redis.pipeline();
  if (ids.length > 0) pipeline.mget(...ids.map((id) => playerBotKey(id)));
  for (const id of ids) {
    pipeline.smismember(playerBotGuildsKey(id), PLAYER_BOT_GUILDS_SENTINEL, guildId);
  }
  if (voiceChannelId !== null) pipeline.get(playerRoomOwnerKey(guildId, voiceChannelId));

  // A pipeline resolves even when a command in it failed; each result carries
  // its own error, and any one of them makes the read untrustworthy.
  const values = ((await pipeline.exec()) ?? []).map(([error, value]) => {
    if (error !== null) throw error;
    return value;
  });

  const offset = ids.length > 0 ? 1 : 0;
  const read = assembleGuildFleet({
    ids,
    payloads: ids.length > 0 ? (values[0] as (string | null)[]) : [],
    membership: values.slice(offset, offset + ids.length) as number[][],
    owner:
      voiceChannelId === null ? null : ((values[offset + ids.length] as string | null) ?? null),
  });

  if (read.gone.length > 0) redis.srem(playerBotIndexKey(), ...read.gone).catch(() => 0);
  return read;
}

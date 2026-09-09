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
import { playerBotIndexKey, playerBotKey } from '../player-events/index.js';

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
    if (typeof parsed.baseUrl !== 'string') return undefined;

    return {
      botId: parsed.botId,
      clientId: parsed.clientId,
      role: parsed.role === 'player' ? 'player' : 'primary',
      baseUrl: parsed.baseUrl,
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

import 'server-only';

/**
 * The signed-in listener's own play history.
 *
 * Distinct from `analytics.ts`, which reports on a whole guild and is gated on
 * managing it. This is personal and needs no guild scope: `SongHistory.userId`
 * is the person who requested the track, so a listener sees what they played
 * wherever they played it.
 *
 * Only plays past the halfway mark appear. A play is stored the moment a track
 * ends for any reason, so the raw table is full of things nobody listened to —
 * a track skipped after two seconds, one that died on a failed stream. Those
 * are not history in the sense anyone means it.
 *
 * The filter lives here, in the read, rather than in the bot's write. The
 * discarded rows are load-bearing elsewhere: the taste profile builds its
 * negative signal from exactly them (`taste.ts` selects rows that were skipped
 * with completion below 0.5, to learn what to stop recommending), and the guild
 * analytics skip rate is a ratio over the unfiltered set. Refusing to write
 * them would leave the recommender unable to tell dislike from silence and peg
 * every skip rate at zero.
 */
import { Prisma } from '@discord-music/database';
import { NotFoundError } from '@discord-music/shared';

import { getDb } from '@/lib/db';

export interface HistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly playedMs: number;
  readonly uri: string | null;
  readonly source: string;
  readonly playedAt: Date;
  /** Fraction of the track that played, 0–1. Always >= 0.5 for a listed row. */
  readonly completion: number;
}

/**
 * Shape `$queryRaw` returns.
 *
 * The column names are camelCase and must stay double-quoted in the SQL below:
 * Prisma maps the *table* to `song_history` but leaves field names alone, and
 * Postgres folds an unquoted identifier to lowercase — `durationMs` unquoted
 * would be looked up as `durationms` and error.
 */
interface HistoryRow {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly playedMs: number;
  readonly uri: string | null;
  readonly source: string;
  readonly playedAt: Date;
}

/** Rows below this fraction never reach the listener's history. */
const MIN_COMPLETION = 0.5;

/** Hard ceiling on one page, so a long-lived account cannot blow up the view. */
export const HISTORY_PAGE_SIZE = 100;

/**
 * Plays of at least {@link MIN_COMPLETION}, newest first.
 *
 * Raw SQL because the predicate compares two columns with arithmetic —
 * `"playedMs" >= "durationMs" * 0.5` — which Prisma's query builder cannot
 * express: its field references support column-to-column comparison but no
 * operators. The index on ("userId", "playedAt") still carries the equality and
 * the ordering; only the completion test is computed per row.
 *
 * `"durationMs" > 0` is not redundant: livestreams are stored with no duration,
 * and half of an unknown length is not a threshold anything can satisfy.
 */
export async function listHistory(
  userId: string,
  limit: number = HISTORY_PAGE_SIZE,
): Promise<readonly HistoryEntry[]> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), HISTORY_PAGE_SIZE);

  const rows = await getDb().$queryRaw<readonly HistoryRow[]>(Prisma.sql`
    SELECT id, title, author, "durationMs", "playedMs", uri,
           source::text AS source, "playedAt"
    FROM song_history
    WHERE "userId" = ${userId}
      AND "durationMs" > 0
      AND "playedMs" >= "durationMs" * ${MIN_COMPLETION}
    ORDER BY "playedAt" DESC
    LIMIT ${take}
  `);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    durationMs: row.durationMs,
    playedMs: row.playedMs,
    uri: row.uri,
    source: row.source.toLowerCase(),
    playedAt: row.playedAt,
    // Capped at 1: `playedMs` is wall-clock since the track started, so a
    // paused track can report more elapsed time than it has audio.
    completion: Math.min(row.playedMs / row.durationMs, 1),
  }));
}

/** How many plays the listener's history holds, under the same filter. */
export async function countHistory(userId: string): Promise<number> {
  const rows = await getDb().$queryRaw<readonly { count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM song_history
    WHERE "userId" = ${userId}
      AND "durationMs" > 0
      AND "playedMs" >= "durationMs" * ${MIN_COMPLETION}
  `);
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Delete one play, scoped to its owner.
 *
 * The `userId` in the filter is the authorization: a row belonging to someone
 * else matches nothing and raises the same not-found as an id that never
 * existed, so this cannot be used to probe for other people's history.
 */
export async function removeHistoryEntry(userId: string, historyId: string): Promise<void> {
  const { count } = await getDb().songHistory.deleteMany({
    where: { id: historyId, userId },
  });
  if (count === 0) throw new NotFoundError('History entry not found.');
}

/**
 * Delete the listener's whole history.
 *
 * Everything of theirs goes, including the sub-50% rows the read filter hides.
 * Clearing history has to mean the data is gone — leaving behind rows the
 * listener was never shown, still feeding the taste profile, would make this
 * button a lie.
 *
 * @returns How many rows were removed.
 */
export async function clearHistory(userId: string): Promise<number> {
  const { count } = await getDb().songHistory.deleteMany({ where: { userId } });
  return count;
}

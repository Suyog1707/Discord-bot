import 'server-only';

/**
 * The signed-in listener's dislikes — the songs autoplay must never bring back.
 *
 * The persistence itself lives in `@discord-music/database`, not here: a
 * thumbs-down pressed on a Discord button and one clicked on this dashboard
 * have to land in the same row under the same canonical key, and two
 * implementations of "what key is this song" would eventually disagree. This
 * module is only the web-side edge — validate the request, name the actor, and
 * tell a live player about it.
 *
 * Unlike the rest of the dashboard's writes, dislikes key on the Discord
 * snowflake rather than the internal `User.id`. The bot knows people by
 * snowflake and creates the minimal `User` row itself, so keying on it is what
 * lets a dislike expressed in a voice channel show up here at all.
 */
import {
  addDislike,
  countDislikes,
  listDislikes as listDislikeRows,
  pageDislikes,
  removeDislike,
  removeDislikes,
} from '@discord-music/database';
import {
  encodePlayerCommand,
  nonEmptyString,
  parseOrThrow,
  playerCommandSchema,
  PLAYER_COMMAND_CHANNEL,
  snowflakeSchema,
  z,
} from '@discord-music/shared';

import { getDb } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

/** One rejected song, as the dashboard renders it. */
export interface DislikeView {
  /** Canonical identity (`artist::title`) — also the delete key. */
  readonly trackKey: string;
  readonly title: string;
  readonly author: string;
  readonly isrc: string | null;
  /** Where the thumbs-down was pressed: `button` | `command` | `dashboard`. */
  readonly source: string;
  readonly createdAt: Date;
}

/** Ceiling on one page of the list, in the spirit of `HISTORY_PAGE_SIZE`. */
export const DISLIKES_PAGE_SIZE = 100;

/**
 * How many keys a bulk removal may still announce to a live player.
 *
 * A handful of removals is somebody fixing a mistake while the music plays, and
 * the player should forget those keys now. A purge of fifty is list management:
 * the planner re-reads dislikes from Postgres on its next generation pass, and
 * the player's in-memory mirror ages out within minutes anyway, so fifty
 * published commands would buy nothing and flood the command channel to buy it.
 */
const LIVE_COMMAND_MAX_KEYS = 10;

/** `?cursor=&limit=` on the list route. */
export const dislikePageQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(DISLIKES_PAGE_SIZE).optional(),
});

export type DislikePageQuery = z.input<typeof dislikePageQuerySchema>;

/**
 * What a client may send when un-rejecting several songs at once.
 *
 * Capped at one page's worth of keys: the UI can only select what it has
 * listed, and an unbounded array is an unbounded statement.
 */
export const dislikeRemoveInputSchema = z.object({
  trackKeys: z.array(z.string().min(1).max(600)).min(1).max(DISLIKES_PAGE_SIZE),
  guildId: snowflakeSchema.optional(),
});

export type DislikeRemoveInputBody = z.input<typeof dislikeRemoveInputSchema>;

/** One page of the list, as the API hands it back. */
export interface DislikePageView {
  readonly items: readonly DislikeView[];
  /** Send back as `?cursor=` for the next page; `null` at the end of the list. */
  readonly nextCursor: string | null;
  /** Present only on the first page — see `pageDislikesForUser`. */
  readonly total?: number;
}

/**
 * What a client may send when rejecting a song.
 *
 * `trackKey` is optional but preferred: the player snapshot carries the key the
 * bot itself would compute, so sending it back means the dashboard rejects the
 * recording the recommender knows rather than the upload's spelling of it.
 *
 * `guildId`/`skipIfPlaying` are transport, not data — they say "a player is
 * live over there, tell it too" and never reach the database row.
 */
export const dislikeInputSchema = z.object({
  title: nonEmptyString(300, 'Title'),
  author: nonEmptyString(300, 'Artist'),
  isrc: z.string().max(32).nullish(),
  trackKey: z.string().min(1).max(600).optional(),
  guildId: snowflakeSchema.optional(),
  skipIfPlaying: z.boolean().optional(),
});

export type DislikeInputBody = z.input<typeof dislikeInputSchema>;

/**
 * Tell a live player about a dislike, and never let that failure surface.
 *
 * The database row is the dislike; the published command is only the immediate
 * effect. If Redis is unset (allowed in development), the bot is offline, or
 * the publish simply fails, the listener has still rejected the song — the
 * planner reads dislikes from Postgres on its next generation pass and will
 * honour it there. Throwing here would turn a working write into a visible
 * error and tempt the caller into retrying a write that already succeeded.
 *
 * Deliberately *not* routed through `sendPlayerCommand`: that helper demands
 * Manage Server on the guild, which is the right gate for pausing everyone's
 * music and the wrong one for "I don't like this song". A dislike is the
 * listener's own statement about their own recommendations.
 */
async function publishToPlayer(command: unknown): Promise<void> {
  try {
    const redis = getRedis();
    if (redis === undefined) return;

    const parsed = parseOrThrow(playerCommandSchema, command);
    await redis.publish(PLAYER_COMMAND_CHANNEL, encodePlayerCommand(parsed));
  } catch (error) {
    try {
      getLogger('dislikes').warn({ err: error }, 'Dislike published to no live player');
    } catch {
      // Logging must not be the thing that breaks a successful write.
    }
  }
}

/** A stored row as the dashboard renders it — internal ids stay in the database. */
function toView(row: {
  readonly trackKey: string;
  readonly title: string;
  readonly author: string;
  readonly isrc: string | null;
  readonly source: string;
  readonly createdAt: Date;
}): DislikeView {
  return {
    trackKey: row.trackKey,
    title: row.title,
    author: row.author,
    isrc: row.isrc,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/**
 * The listener's rejected songs, newest first.
 *
 * The unpaginated read the server-rendered page still uses. New callers want
 * `pageDislikesForUser`: at the 500-row cap this returns only the newest
 * hundred, which is a view of the list rather than the list.
 */
export async function listDislikes(user: {
  readonly discordId: string;
}): Promise<readonly DislikeView[]> {
  const rows = await listDislikeRows(getDb(), user.discordId, DISLIKES_PAGE_SIZE);

  return rows.map(toView);
}

/**
 * One page of rejected songs, newest first.
 *
 * `total` comes back only when no cursor was given. It is there to say how
 * close this listener is to the 500 cap, which is a thing to show once at the
 * top of the list — paying for a `COUNT` on every "Load more" would be spending
 * a query per page on a number nobody re-reads.
 *
 * A cursor that is stale — the row behind it was just removed — is not an
 * error; the database layer serves the first page for it, and the caller sees a
 * list that starts over rather than a failure.
 */
export async function pageDislikesForUser(
  user: { readonly discordId: string },
  // `| undefined` explicitly: under `exactOptionalPropertyTypes` a parsed query
  // object with absent keys typed as optional cannot be passed otherwise.
  options: {
    readonly cursor?: string | null | undefined;
    readonly limit?: number | undefined;
  } = {},
): Promise<DislikePageView> {
  const db = getDb();
  const cursor = options.cursor ?? null;

  const page = await pageDislikes(db, user.discordId, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(cursor === null ? {} : { cursor }),
  });
  const items = page.rows.map(toView);

  if (cursor !== null) return { items, nextCursor: page.nextCursor };
  return { items, nextCursor: page.nextCursor, total: await countDislikes(db, user.discordId) };
}

/**
 * Reject a song for this listener.
 *
 * @param opts.guildId - Overrides any `guildId` in the body, for callers that
 *   already know the guild from the URL.
 * @returns `added: false` when it was already disliked — idempotent, so a
 *   double click is not an error.
 */
export async function addDislikeForUser(
  user: { readonly discordId: string; readonly username: string },
  input: unknown,
  opts?: { readonly guildId?: string },
): Promise<{ readonly added: boolean; readonly trackKey: string }> {
  const parsed = parseOrThrow(dislikeInputSchema, input);
  const guildId = opts?.guildId ?? parsed.guildId;

  const result = await addDislike(
    getDb(),
    user.discordId,
    user.username,
    // Spread rather than assign: under `exactOptionalPropertyTypes` an explicit
    // `isrc: undefined` is not the same as an absent one.
    {
      title: parsed.title,
      author: parsed.author,
      ...(parsed.isrc === undefined ? {} : { isrc: parsed.isrc }),
      ...(parsed.trackKey === undefined ? {} : { trackKey: parsed.trackKey }),
    },
    'dashboard',
  );

  if (guildId !== undefined) {
    await publishToPlayer({
      action: 'dislike',
      guildId,
      issuedBy: user.discordId,
      trackKey: result.trackKey,
      skipIfPlaying: parsed.skipIfPlaying ?? true,
    });
  }

  return result;
}

/**
 * Undo a dislike.
 *
 * The command is only published when a row actually went away: telling a player
 * to forget a key nobody had rejected is noise, and a `false` here means the
 * key was never this listener's to remove.
 *
 * @returns Whether a row was removed.
 */
export async function removeDislikeForUser(
  user: { readonly discordId: string },
  trackKey: string,
  guildId?: string,
): Promise<boolean> {
  const removed = await removeDislike(getDb(), user.discordId, trackKey);

  if (removed && guildId !== undefined) {
    await publishToPlayer({
      action: 'undislike',
      guildId,
      issuedBy: user.discordId,
      trackKey,
    });
  }

  return removed;
}

/**
 * Un-reject several songs at once.
 *
 * Ownership lives in the database layer's `where`, so keys belonging to
 * somebody else are counted as removals of nothing rather than rejected — the
 * caller learns how many of *their* rows went away and nothing about anyone
 * else's.
 *
 * Live players are told only about small removals (`LIVE_COMMAND_MAX_KEYS`).
 * The commands are published for every requested key rather than only the ones
 * that existed, because `removeDislikes` reports a total and not a per-key
 * outcome; telling a player to forget a key it never held is a no-op.
 *
 * @returns How many rows were actually removed.
 */
export async function removeDislikesForUser(
  user: { readonly discordId: string },
  trackKeys: readonly string[],
  guildId?: string,
): Promise<number> {
  const keys = [...new Set(trackKeys)];
  const removed = await removeDislikes(getDb(), user.discordId, keys);

  if (removed > 0 && guildId !== undefined && keys.length <= LIVE_COMMAND_MAX_KEYS) {
    await Promise.all(
      keys.map(async (trackKey) =>
        publishToPlayer({ action: 'undislike', guildId, issuedBy: user.discordId, trackKey }),
      ),
    );
  }

  return removed;
}

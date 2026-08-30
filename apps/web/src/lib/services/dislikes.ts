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
  listDislikes as listDislikeRows,
  removeDislike,
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

/** The listener's rejected songs, newest first. */
export async function listDislikes(user: {
  readonly discordId: string;
}): Promise<readonly DislikeView[]> {
  const rows = await listDislikeRows(getDb(), user.discordId, DISLIKES_PAGE_SIZE);

  return rows.map((row) => ({
    trackKey: row.trackKey,
    title: row.title,
    author: row.author,
    isrc: row.isrc,
    source: row.source,
    createdAt: row.createdAt,
  }));
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

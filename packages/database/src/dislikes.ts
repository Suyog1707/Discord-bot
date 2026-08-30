/**
 * Per-user dislikes — the songs a listener has told the recommender to stop
 * offering.
 *
 * Rows are keyed by the canonical track identity (`identityOf(author, title)`)
 * rather than by a provider identifier, because a dislike is a statement about
 * a recording, not about the row that happened to be playing. The same song
 * arrives as a Spotify id one night and a SoundCloud id the next; keying on
 * either would let it walk straight back in through the other door — which is
 * the whole failure the identity layer exists to prevent.
 *
 * Like favorites, dislikes hang off the `User` row and a bot-only user gets a
 * minimal row created here, so a dislike expressed in a voice channel is still
 * there the day that person signs into the dashboard.
 *
 * This lives in the database package, as free functions over a `PrismaClient`,
 * because both surfaces need it: the bot wraps it in a service and the
 * dashboard's route handlers call it directly. A dislike added from the
 * dashboard and one added from a button must land in the same row under the
 * same key, and two implementations of that would guarantee they eventually
 * did not.
 */
import { identityOf, LIMITS, normaliseIsrc, ValidationError } from '@discord-music/shared';
import type { DislikedTrack, PrismaClient } from '@prisma/client';

import { isUniqueConstraintError } from './client.js';

/** Where the dislike was expressed. Mirrors `DislikedTrack.source`. */
export type DislikeSource = 'button' | 'command' | 'dashboard';

/** The minimum a caller must know about a track to reject it. */
export interface DislikeInput {
  readonly title: string;
  readonly author: string;
  readonly isrc?: string | null;
  /**
   * The canonical key to store, when the caller knows a better one than the
   * title and author imply. An autoplay discovery is queued under the
   * upload's spelling ("Song (Official Video)" by "Artist - Topic") but was
   * chosen as a Last.fm candidate whose key lives in `QueuedTrack.sourceKey`;
   * disliking the upload must dislike the candidate, or the same song comes
   * straight back under its own name.
   */
  readonly trackKey?: string;
}

/** Hard cap per user — an abuse guard in the spirit of LIMITS. */
export const DISLIKES_MAX_PER_USER = LIMITS.PLAYLIST_MAX_TRACKS;

/**
 * How many rows a lookup will read for a whole voice channel. The planner asks
 * for these on every generation pass, so the query is bounded rather than
 * paginated: a listener past this many dislikes has already expressed more
 * preference than one refill can use.
 */
const LOOKUP_TAKE = 2000;

/**
 * The `User` row a dislike hangs off, created on demand.
 *
 * A listener who has only ever used the bot has no dashboard account yet; the
 * upsert is what lets their opinion survive until they sign in.
 */
async function userIdFor(
  prisma: PrismaClient,
  discordId: string,
  username: string,
): Promise<string> {
  const user = await prisma.user.upsert({
    where: { discordId },
    update: {},
    create: { discordId, username },
    select: { id: true },
  });
  return user.id;
}

/**
 * Persist a dislike. `added` is false when the song was already disliked.
 *
 * The pre-read is the common path, but the unique constraint is what makes
 * this safe: a button press and a `/dislike` racing on the same track both
 * see "not there yet", and the loser must report "already disliked" rather
 * than blow up in the interaction handler.
 *
 * The resolved `trackKey` comes back either way, because the caller usually
 * needs it next — to publish a `dislike` player command, or to skip the track
 * that is playing right now.
 */
export async function addDislike(
  prisma: PrismaClient,
  discordId: string,
  username: string,
  track: DislikeInput,
  source: DislikeSource,
): Promise<{ readonly added: boolean; readonly trackKey: string }> {
  const userId = await userIdFor(prisma, discordId, username);

  const trackKey = track.trackKey ?? identityOf(track.author, track.title).key;

  const existing = await prisma.dislikedTrack.findUnique({
    where: { userId_trackKey: { userId, trackKey } },
    select: { id: true },
  });
  if (existing !== null) return { added: false, trackKey };

  // Checked AFTER the idempotency return: a listener at the cap pressing 👎
  // on a song already on their list is not adding anything.
  const count = await prisma.dislikedTrack.count({ where: { userId } });
  if (count >= DISLIKES_MAX_PER_USER) {
    throw new ValidationError(`You can dislike up to ${String(DISLIKES_MAX_PER_USER)} tracks.`);
  }

  try {
    await prisma.dislikedTrack.create({
      data: {
        userId,
        trackKey,
        isrc: normaliseIsrc(track.isrc),
        title: track.title,
        author: track.author,
        source,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { added: false, trackKey };
    throw error;
  }
  return { added: true, trackKey };
}

/** Undo a dislike, by canonical key. Returns false when there was none. */
export async function removeDislike(
  prisma: PrismaClient,
  discordId: string,
  trackKey: string,
): Promise<boolean> {
  const { count } = await prisma.dislikedTrack.deleteMany({
    where: { trackKey, user: { discordId } },
  });
  return count > 0;
}

/** Newest first. */
export async function listDislikes(
  prisma: PrismaClient,
  discordId: string,
  limit = 50,
): Promise<readonly DislikedTrack[]> {
  return prisma.dislikedTrack.findMany({
    where: { user: { discordId } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** One page of a listener's rejected songs, newest first. */
export interface DislikePage {
  readonly rows: readonly DislikedTrack[];
  /** Opaque cursor for the next page, or `null` when this was the last one. */
  readonly nextCursor: string | null;
}

/** Widest page a caller may ask for; anything larger is clamped down to it. */
export const DISLIKES_PAGE_LIMIT_MAX = 100;

/** Page size when the caller expresses no preference. */
export const DISLIKES_PAGE_LIMIT_DEFAULT = 50;

/**
 * Keys per `deleteMany`. A purge can name every key a page knows about, and one
 * unbounded `IN` list is how a management action turns into a statement the
 * database refuses to plan.
 */
const DELETE_CHUNK_SIZE = 200;

/** Whatever the caller asked for, expressed as a page size we will serve. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DISLIKES_PAGE_LIMIT_DEFAULT;
  return Math.min(DISLIKES_PAGE_LIMIT_MAX, Math.max(1, Math.trunc(limit)));
}

/**
 * The cursor row id, but only when that row belongs to this listener.
 *
 * The ownership guard exists because Prisma's `cursor` locates a row by primary
 * key and only then applies the `where`. The rows that come back are still
 * filtered to this listener — nobody else's dislike can be read — but the
 * *position* would be taken from a stranger's row, so a guessed id would decide
 * which of the listener's own rows they are allowed to see. One extra indexed
 * read (the row's `user.discordId`) closes that: a cursor is honoured only when
 * it is theirs.
 *
 * An id that is not theirs, or no longer exists because the row was just
 * removed, comes back `null`, which the caller reads as "start over" rather
 * than as an error. A stale "Load more" click after a bulk purge must show the
 * first page again, never a 500.
 */
async function ownedCursorId(
  prisma: PrismaClient,
  discordId: string,
  cursor: string | null | undefined,
): Promise<string | null> {
  if (cursor === undefined || cursor === null || cursor.length === 0) return null;

  const row = await prisma.dislikedTrack.findUnique({
    where: { id: cursor },
    select: { user: { select: { discordId: true } } },
  });
  return row?.user.discordId === discordId ? cursor : null;
}

/**
 * One page of rejected songs, newest first, by keyset.
 *
 * Offsets are the wrong tool here: rows leave this list while it is being read
 * — removing them is the entire point of the management page — and `skip: n`
 * after a deletion silently swallows a row from the next page. Resuming from
 * the last row seen keeps every row visible exactly once.
 *
 * `createdAt` alone cannot be that resume point: two dislikes land in the same
 * millisecond often enough (a bulk import, a fast pair of button presses), and
 * the pair would be ambiguous. The sort is therefore `(createdAt desc, id
 * desc)` and the cursor is the row id — exactly the unique Prisma needs to
 * position a cursor against that ordering.
 *
 * `take: limit + 1` answers "is there more" without a second query: the extra
 * row is read, never returned, and its existence is what produces a cursor.
 */
export async function pageDislikes(
  prisma: PrismaClient,
  discordId: string,
  options: {
    /** 1..100, default 50. Out-of-range values are clamped, not rejected. */
    readonly limit?: number;
    /** `nextCursor` from the previous page. */
    readonly cursor?: string | null;
  } = {},
): Promise<DislikePage> {
  const take = clampLimit(options.limit);
  const cursorId = await ownedCursorId(prisma, discordId, options.cursor);

  const query = {
    where: { user: { discordId } },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: take + 1,
  };

  const rows =
    cursorId === null
      ? await prisma.dislikedTrack.findMany(query)
      : // The row can still disappear between the ownership read and this one,
        // and Prisma throws when its cursor points at nothing. A vanished
        // cursor is stale, not broken: serve the first page instead.
        await prisma.dislikedTrack
          .findMany({ ...query, cursor: { id: cursorId }, skip: 1 })
          .catch(() => prisma.dislikedTrack.findMany(query));

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page.at(-1);

  return { rows: page, nextCursor: hasMore && last !== undefined ? last.id : null };
}

/**
 * How many songs this listener has rejected.
 *
 * Read once per first page rather than per page: it exists to tell somebody how
 * close they are to `DISLIKES_MAX_PER_USER`, and a count that is a few seconds
 * old still says that truthfully.
 */
export async function countDislikes(prisma: PrismaClient, discordId: string): Promise<number> {
  return prisma.dislikedTrack.count({ where: { user: { discordId } } });
}

/**
 * Un-reject many songs at once; returns how many rows actually went away.
 *
 * Ownership is the `where`, not a pre-read: `user: { discordId }` means another
 * listener's row cannot be deleted or counted however the keys were obtained,
 * which is the only guarantee worth having when the keys arrive from a client.
 * Keys that were never disliked are simply not counted, so the call is
 * idempotent — a double-submitted purge is not an error.
 */
export async function removeDislikes(
  prisma: PrismaClient,
  discordId: string,
  trackKeys: readonly string[],
): Promise<number> {
  const keys = [...new Set(trackKeys)].filter((key) => key.length > 0);
  if (keys.length === 0) return 0;

  let removed = 0;
  for (let index = 0; index < keys.length; index += DELETE_CHUNK_SIZE) {
    const chunk = keys.slice(index, index + DELETE_CHUNK_SIZE);
    const { count } = await prisma.dislikedTrack.deleteMany({
      where: { user: { discordId }, trackKey: { in: chunk } },
    });
    removed += count;
  }
  return removed;
}

/** Whether this listener has already rejected that canonical key. */
export async function isDisliked(
  prisma: PrismaClient,
  discordId: string,
  trackKey: string,
): Promise<boolean> {
  const row = await prisma.dislikedTrack.findFirst({
    where: { trackKey, user: { discordId } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Canonical keys disliked by ANY of these listeners — the planner's hard
 * exclusion set for a voice channel.
 *
 * A union rather than an intersection on purpose: one person in the room
 * having rejected a song is reason enough not to play it to the room, and the
 * cost of over-excluding is one candidate out of a pool of hundreds.
 */
export async function dislikedKeysFor(
  prisma: PrismaClient,
  discordIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (discordIds.length === 0) return new Set<string>();

  const rows = await prisma.dislikedTrack.findMany({
    where: { user: { discordId: { in: [...discordIds] } } },
    select: { trackKey: true },
    take: LOOKUP_TAKE,
  });
  return new Set(rows.map((row) => row.trackKey));
}

/**
 * artistKey → how many of that artist's songs these listeners have rejected,
 * for the soft artist penalty.
 *
 * Recomputed from the stored `author`/`title` rather than persisted, because
 * the artist key is derived: `identityOf` gets smarter over time, and a
 * denormalised column would freeze old rows at whatever the rules were the
 * day they were written.
 */
export async function dislikedArtistCountsFor(
  prisma: PrismaClient,
  discordIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  if (discordIds.length === 0) return counts;

  const rows = await prisma.dislikedTrack.findMany({
    where: { user: { discordId: { in: [...discordIds] } } },
    select: { author: true, title: true },
    take: LOOKUP_TAKE,
  });

  for (const row of rows) {
    const { artistKey } = identityOf(row.author, row.title);
    if (artistKey.length === 0) continue;
    counts.set(artistKey, (counts.get(artistKey) ?? 0) + 1);
  }
  return counts;
}

/**
 * Both of the above from one read, for the planner: it needs the keys and
 * the artist counts on every generation pass, and they come from the same
 * rows. Newest first, so a heavy disliker's bounded page is their most
 * recent opinions rather than an arbitrary slice.
 */
export async function dislikesFor(
  prisma: PrismaClient,
  discordIds: readonly string[],
): Promise<{
  readonly keys: ReadonlySet<string>;
  readonly artistCounts: ReadonlyMap<string, number>;
}> {
  const keys = new Set<string>();
  const artistCounts = new Map<string, number>();
  if (discordIds.length === 0) return { keys, artistCounts };

  const rows = await prisma.dislikedTrack.findMany({
    where: { user: { discordId: { in: [...discordIds] } } },
    select: { trackKey: true, author: true, title: true },
    orderBy: { createdAt: 'desc' },
    take: LOOKUP_TAKE,
  });
  for (const row of rows) {
    keys.add(row.trackKey);
    const { artistKey } = identityOf(row.author, row.title);
    if (artistKey.length === 0) continue;
    artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
  }
  return { keys, artistCounts };
}

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
 */
import {
  type DislikedTrack,
  isUniqueConstraintError,
  type PrismaClient,
} from '@discord-music/database';
import { LIMITS, ValidationError } from '@discord-music/shared';

import { identityOf } from '../ai/identity.js';
import { normaliseIsrc } from '../music/canonical-track.js';

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

export class DislikesService {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async #userIdFor(discordId: string, username: string): Promise<string> {
    const user = await this.#prisma.user.upsert({
      where: { discordId },
      update: {},
      create: { discordId, username },
      select: { id: true },
    });
    return user.id;
  }

  /**
   * Persist a dislike. Returns false when the song was already disliked.
   *
   * The pre-read is the common path, but the unique constraint is what makes
   * this safe: a button press and a `/dislike` racing on the same track both
   * see "not there yet", and the loser must report "already disliked" rather
   * than blow up in the interaction handler.
   */
  async add(
    discordId: string,
    username: string,
    track: DislikeInput,
    source: DislikeSource,
  ): Promise<boolean> {
    const userId = await this.#userIdFor(discordId, username);

    const count = await this.#prisma.dislikedTrack.count({ where: { userId } });
    if (count >= DISLIKES_MAX_PER_USER) {
      throw new ValidationError(`You can dislike up to ${String(DISLIKES_MAX_PER_USER)} tracks.`);
    }

    const trackKey = track.trackKey ?? identityOf(track.author, track.title).key;

    const existing = await this.#prisma.dislikedTrack.findUnique({
      where: { userId_trackKey: { userId, trackKey } },
      select: { id: true },
    });
    if (existing !== null) return false;

    try {
      await this.#prisma.dislikedTrack.create({
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
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
    return true;
  }

  /** Undo a dislike, by canonical key. Returns false when there was none. */
  async remove(discordId: string, trackKey: string): Promise<boolean> {
    const { count } = await this.#prisma.dislikedTrack.deleteMany({
      where: { trackKey, user: { discordId } },
    });
    return count > 0;
  }

  /** Newest first. */
  async list(discordId: string, limit = 25): Promise<readonly DislikedTrack[]> {
    return this.#prisma.dislikedTrack.findMany({
      where: { user: { discordId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Canonical keys disliked by ANY of these listeners — the planner's hard
   * exclusion set for a voice channel.
   *
   * A union rather than an intersection on purpose: one person in the room
   * having rejected a song is reason enough not to play it to the room, and the
   * cost of over-excluding is one candidate out of a pool of hundreds.
   */
  async keysFor(discordIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (discordIds.length === 0) return new Set<string>();

    const rows = await this.#prisma.dislikedTrack.findMany({
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
  /**
   * Both of the above from one read, for the planner: it needs the keys and
   * the artist counts on every generation pass, and they come from the same
   * rows. Newest first, so a heavy disliker's bounded page is their most
   * recent opinions rather than an arbitrary slice.
   */
  async dislikesFor(discordIds: readonly string[]): Promise<{
    readonly keys: ReadonlySet<string>;
    readonly artistCounts: ReadonlyMap<string, number>;
  }> {
    const keys = new Set<string>();
    const artistCounts = new Map<string, number>();
    if (discordIds.length === 0) return { keys, artistCounts };

    const rows = await this.#prisma.dislikedTrack.findMany({
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

  async artistCountsFor(discordIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (discordIds.length === 0) return counts;

    const rows = await this.#prisma.dislikedTrack.findMany({
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
}

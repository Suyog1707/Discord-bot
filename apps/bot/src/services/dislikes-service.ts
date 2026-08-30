/**
 * Per-user dislikes, as the bot consumes them.
 *
 * The logic itself moved to `@discord-music/database` (`src/dislikes.ts`) when
 * the dashboard grew a "Not like" surface: a dislike added from a web request
 * and one added from a button in a voice channel have to land in the same row,
 * under the same canonical key, subject to the same cap. Two implementations
 * of that would eventually disagree, and a dislike that only half-counts is
 * indistinguishable from a recommender that ignores you.
 *
 * What stays here is the shape the bot already depends on: one object holding
 * the client, so commands and the planner keep injecting a service rather than
 * threading `prisma` through every call site.
 */
import {
  addDislike,
  type DislikedTrack,
  dislikedArtistCountsFor,
  dislikedKeysFor,
  type DislikeInput,
  DISLIKES_MAX_PER_USER,
  dislikesFor,
  type DislikeSource,
  listDislikes,
  type PrismaClient,
  removeDislike,
} from '@discord-music/database';

export { DISLIKES_MAX_PER_USER, type DislikeInput, type DislikeSource };

export class DislikesService {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /** Persist a dislike. Returns false when the song was already disliked. */
  async add(
    discordId: string,
    username: string,
    track: DislikeInput,
    source: DislikeSource,
  ): Promise<boolean> {
    const { added } = await addDislike(this.#prisma, discordId, username, track, source);
    return added;
  }

  /** Undo a dislike, by canonical key. Returns false when there was none. */
  async remove(discordId: string, trackKey: string): Promise<boolean> {
    return removeDislike(this.#prisma, discordId, trackKey);
  }

  /** Newest first. */
  async list(discordId: string, limit = 25): Promise<readonly DislikedTrack[]> {
    return listDislikes(this.#prisma, discordId, limit);
  }

  /**
   * Canonical keys disliked by ANY of these listeners — the planner's hard
   * exclusion set for a voice channel.
   */
  async keysFor(discordIds: readonly string[]): Promise<ReadonlySet<string>> {
    return dislikedKeysFor(this.#prisma, discordIds);
  }

  /** artistKey → how many of that artist's songs these listeners rejected. */
  async artistCountsFor(discordIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return dislikedArtistCountsFor(this.#prisma, discordIds);
  }

  /** Both of the above from one read, for the planner's generation pass. */
  async dislikesFor(discordIds: readonly string[]): Promise<{
    readonly keys: ReadonlySet<string>;
    readonly artistCounts: ReadonlyMap<string, number>;
  }> {
    return dislikesFor(this.#prisma, discordIds);
  }
}

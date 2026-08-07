/**
 * Per-user favorite tracks.
 *
 * Favorites belong to the `User` row, which normally appears on first
 * dashboard sign-in. A bot-only user gets a minimal row created here, so the
 * same favorites surface on the dashboard the day they do sign in — the
 * Discord snowflake is the identity anchor in both places.
 */
import {
  MusicSource as DbMusicSource,
  type FavoriteTrack,
  type PrismaClient,
} from '@discord-music/database';
import { LIMITS, type MusicSource } from '@discord-music/shared';

import type { QueuedTrack } from '../music/track.js';

const TO_DB_SOURCE: Record<MusicSource, DbMusicSource> = {
  youtube: DbMusicSource.YOUTUBE,
  spotify: DbMusicSource.SPOTIFY,
  soundcloud: DbMusicSource.SOUNDCLOUD,
  deezer: DbMusicSource.DEEZER,
};

/** Hard cap per user — an abuse guard in the spirit of LIMITS. */
export const FAVORITES_MAX_PER_USER = LIMITS.PLAYLIST_MAX_TRACKS;

export class FavoritesService {
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

  /** Save a track. Returns false when it was already a favorite. */
  async add(discordId: string, username: string, track: QueuedTrack): Promise<boolean> {
    const userId = await this.#userIdFor(discordId, username);

    const count = await this.#prisma.favoriteTrack.count({ where: { userId } });
    if (count >= FAVORITES_MAX_PER_USER) {
      throw new Error(`You can save up to ${String(FAVORITES_MAX_PER_USER)} favorites.`);
    }

    const existing = await this.#prisma.favoriteTrack.findUnique({
      where: { userId_identifier: { userId, identifier: track.identifier } },
      select: { id: true },
    });
    if (existing !== null) return false;

    await this.#prisma.favoriteTrack.create({
      data: {
        userId,
        identifier: track.identifier,
        title: track.title,
        author: track.author,
        durationMs: track.durationMs,
        uri: track.uri,
        source: TO_DB_SOURCE[track.source],
        artworkUrl: track.artworkUrl,
      },
    });
    return true;
  }

  /** Newest first. */
  async list(discordId: string, limit = 25): Promise<readonly FavoriteTrack[]> {
    return this.#prisma.favoriteTrack.findMany({
      where: { user: { discordId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Remove by identifier. Returns false when it was not a favorite. */
  async remove(discordId: string, identifier: string): Promise<boolean> {
    const { count } = await this.#prisma.favoriteTrack.deleteMany({
      where: { identifier, user: { discordId } },
    });
    return count > 0;
  }
}

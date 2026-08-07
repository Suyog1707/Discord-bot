import 'server-only';

/**
 * The signed-in user's favorite tracks. Written from the bot (`/favorite add`)
 * and read/removed here — the Discord snowflake anchors both sides to the same
 * User row, so favorites saved in Discord appear on the dashboard immediately.
 */
import { NotFoundError } from '@discord-music/shared';

import { getDb } from '@/lib/db';

export interface FavoriteView {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly uri: string | null;
  readonly artworkUrl: string | null;
  readonly source: string;
  readonly createdAt: Date;
}

export async function listFavorites(userId: string): Promise<readonly FavoriteView[]> {
  const rows = await getDb().favoriteTrack.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      author: true,
      durationMs: true,
      uri: true,
      artworkUrl: true,
      source: true,
      createdAt: true,
    },
  });
  return rows;
}

/** Remove one favorite, scoped to its owner. */
export async function removeFavorite(userId: string, favoriteId: string): Promise<void> {
  const { count } = await getDb().favoriteTrack.deleteMany({
    where: { id: favoriteId, userId },
  });
  if (count === 0) throw new NotFoundError('Favorite not found.');
}

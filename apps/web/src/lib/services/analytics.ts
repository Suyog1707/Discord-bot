import 'server-only';

/**
 * Listening analytics over SongHistory (docs/FEATURES.md: Analytics).
 * All queries are guild-scoped and authorized via `requireManagedGuild`.
 */
import { requireManagedGuild } from '@/lib/authz';
import { getDb } from '@/lib/db';

export interface TopTrack {
  readonly identifier: string;
  readonly title: string;
  readonly author: string;
  readonly plays: number;
}

export interface RecentPlay {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly uri: string | null;
  readonly source: string;
  readonly skipped: boolean;
  readonly playedAt: Date;
}

export interface GuildAnalytics {
  readonly totalPlays: number;
  readonly uniqueTracks: number;
  readonly skipRate: number;
  readonly topTracks: readonly TopTrack[];
  readonly recentPlays: readonly RecentPlay[];
}

const WINDOW_DAYS = 30;

export async function getGuildAnalytics(
  userId: string,
  discordGuildId: string,
): Promise<GuildAnalytics> {
  const { guild } = await requireManagedGuild(userId, discordGuildId);
  const db = getDb();
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = { guildId: guild.id, playedAt: { gte: since } };

  const [totalPlays, skippedPlays, grouped, recent] = await Promise.all([
    db.songHistory.count({ where }),
    db.songHistory.count({ where: { ...where, skipped: true } }),
    db.songHistory.groupBy({
      by: ['identifier', 'title', 'author'],
      where,
      _count: { identifier: true },
      orderBy: { _count: { identifier: 'desc' } },
      take: 10,
    }),
    db.songHistory.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        title: true,
        author: true,
        uri: true,
        source: true,
        skipped: true,
        playedAt: true,
      },
    }),
  ]);

  return {
    totalPlays,
    uniqueTracks: grouped.length,
    skipRate: totalPlays === 0 ? 0 : skippedPlays / totalPlays,
    topTracks: grouped.map((row) => ({
      identifier: row.identifier,
      title: row.title,
      author: row.author,
      plays: row._count.identifier,
    })),
    recentPlays: recent.map((row) => ({ ...row, source: row.source.toLowerCase() })),
  };
}

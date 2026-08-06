/** GET /api/music/:guildId/history — recent plays for a managed server. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { getGuildAnalytics } from '@/lib/services/analytics';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ guildId: string }>(
  'GET /api/music/:guildId/history',
  'read',
  async ({ user, params }) => {
    const analytics = await getGuildAnalytics(user.id, params.guildId);
    return apiSuccess({ recentPlays: analytics.recentPlays });
  },
);

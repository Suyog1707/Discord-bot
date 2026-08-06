/** GET /api/server/:guildId/analytics — 30-day listening analytics. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { getGuildAnalytics } from '@/lib/services/analytics';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ guildId: string }>(
  'GET /api/server/:guildId/analytics',
  'read',
  async ({ user, params }) => apiSuccess(await getGuildAnalytics(user.id, params.guildId)),
);

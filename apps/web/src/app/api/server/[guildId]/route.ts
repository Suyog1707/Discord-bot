/** GET /api/server/:guildId — settings + persisted queue snapshot. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { getServerDetail } from '@/lib/services/guilds';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ guildId: string }>(
  'GET /api/server/:guildId',
  'read',
  async ({ user, params }) => apiSuccess(await getServerDetail(user.id, params.guildId)),
);

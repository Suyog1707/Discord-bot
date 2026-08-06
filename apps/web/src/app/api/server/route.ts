/** GET /api/server — manageable servers, annotated with bot presence. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { listServers } from '@/lib/services/guilds';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/server', 'read', async ({ user }) =>
  apiSuccess(await listServers(user.id)),
);

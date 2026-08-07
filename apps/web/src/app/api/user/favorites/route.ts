/** GET /api/user/favorites — the signed-in user's favorite tracks. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { listFavorites } from '@/lib/services/favorites';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/user/favorites', 'read', async ({ user }) =>
  apiSuccess(await listFavorites(user.id)),
);

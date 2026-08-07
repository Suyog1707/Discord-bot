/** DELETE /api/user/favorites/:favoriteId — remove one favorite. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { removeFavorite } from '@/lib/services/favorites';

export const dynamic = 'force-dynamic';

export const DELETE = authedRoute<{ favoriteId: string }>(
  'DELETE /api/user/favorites/:favoriteId',
  'write',
  async ({ user, params }) => {
    await removeFavorite(user.id, params.favoriteId);
    return apiSuccess({ removed: true });
  },
);

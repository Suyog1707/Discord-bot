/** DELETE /api/user/history/:historyId — remove one play from the history. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { removeHistoryEntry } from '@/lib/services/history';

export const dynamic = 'force-dynamic';

export const DELETE = authedRoute<{ historyId: string }>(
  'DELETE /api/user/history/:historyId',
  'write',
  async ({ user, params }) => {
    await removeHistoryEntry(user.id, params.historyId);
    return apiSuccess({ removed: true });
  },
);

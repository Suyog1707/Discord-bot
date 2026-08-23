/**
 * GET    /api/user/history — the signed-in listener's plays, 50%+ only.
 * DELETE /api/user/history — clear the whole history.
 */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { clearHistory, listHistory } from '@/lib/services/history';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/user/history', 'read', async ({ user }) =>
  apiSuccess(await listHistory(user.id)),
);

export const DELETE = authedRoute('DELETE /api/user/history', 'write', async ({ user }) =>
  apiSuccess({ removed: await clearHistory(user.id) }),
);

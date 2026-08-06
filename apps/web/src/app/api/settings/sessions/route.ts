/** /api/settings/sessions — GET: active sessions. DELETE: revoke all others. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, currentSessionToken } from '@/lib/api-route';
import { listSessions, revokeOtherSessions } from '@/lib/services/account';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/settings/sessions', 'read', async ({ user, request }) =>
  apiSuccess(await listSessions(user.id, currentSessionToken(request))),
);

export const DELETE = authedRoute(
  'DELETE /api/settings/sessions',
  'write',
  async ({ user, request }) => {
    const revoked = await revokeOtherSessions(user.id, currentSessionToken(request));
    return apiSuccess({ revoked });
  },
);

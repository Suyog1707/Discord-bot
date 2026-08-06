/** DELETE /api/settings/sessions/:sessionId — revoke one session. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { revokeSession } from '@/lib/services/account';

export const dynamic = 'force-dynamic';

export const DELETE = authedRoute<{ sessionId: string }>(
  'DELETE /api/settings/sessions/:sessionId',
  'write',
  async ({ user, params }) => {
    await revokeSession(user.id, params.sessionId);
    return apiSuccess({ deleted: true });
  },
);

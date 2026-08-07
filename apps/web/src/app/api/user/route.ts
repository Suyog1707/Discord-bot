/** GET /api/user — the signed-in user's profile and playlist count. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { getProfile } from '@/lib/services/account';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/user', 'read', async ({ user }) =>
  apiSuccess(await getProfile(user.id)),
);

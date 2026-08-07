/** GET /api/spotify — link status · DELETE — disconnect. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { disconnectSpotify, getSpotifyStatus } from '@/lib/services/spotify';
import { isSpotifyConfigured } from '@/lib/spotify/client';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/spotify', 'read', async ({ user }) =>
  apiSuccess({ configured: isSpotifyConfigured(), ...(await getSpotifyStatus(user.id)) }),
);

export const DELETE = authedRoute('DELETE /api/spotify', 'write', async ({ user }) => {
  await disconnectSpotify(user.id);
  return apiSuccess({ disconnected: true });
});

/** POST /api/playlist/:playlistId/tracks — append a track. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { addTrackToPlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ playlistId: string }>(
  'POST /api/playlist/:playlistId/tracks',
  'write',
  async ({ user, request, params }) =>
    apiSuccess(await addTrackToPlaylist(user.id, params.playlistId, await readJsonBody(request)), {
      status: 201,
    }),
);

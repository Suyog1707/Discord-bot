/** /api/playlist/:playlistId — GET detail, PATCH rename/visibility, DELETE. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { deletePlaylist, getPlaylist, updatePlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ playlistId: string }>(
  'GET /api/playlist/:playlistId',
  'read',
  async ({ user, params }) => apiSuccess(await getPlaylist(user.id, params.playlistId)),
);

export const PATCH = authedRoute<{ playlistId: string }>(
  'PATCH /api/playlist/:playlistId',
  'write',
  async ({ user, request, params }) =>
    apiSuccess(await updatePlaylist(user.id, params.playlistId, await readJsonBody(request))),
);

export const DELETE = authedRoute<{ playlistId: string }>(
  'DELETE /api/playlist/:playlistId',
  'write',
  async ({ user, params }) => {
    await deletePlaylist(user.id, params.playlistId);
    return apiSuccess({ deleted: true });
  },
);

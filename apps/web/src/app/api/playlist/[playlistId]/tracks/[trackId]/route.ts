/** DELETE /api/playlist/:playlistId/tracks/:trackId — remove a track. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { removeTrackFromPlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const DELETE = authedRoute<{ playlistId: string; trackId: string }>(
  'DELETE /api/playlist/:playlistId/tracks/:trackId',
  'write',
  async ({ user, params }) => {
    await removeTrackFromPlaylist(user.id, params.playlistId, params.trackId);
    return apiSuccess({ deleted: true });
  },
);

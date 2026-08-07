/** POST /api/playlist/:playlistId/duplicate — copy a playlist, tracks included. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { duplicatePlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ playlistId: string }>(
  'POST /api/playlist/:playlistId/duplicate',
  'write',
  async ({ user, params }) => {
    const copy = await duplicatePlaylist(user.id, params.playlistId);
    return apiSuccess({ id: copy.id, name: copy.name, trackCount: copy.trackCount });
  },
);

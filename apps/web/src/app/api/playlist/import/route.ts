/** POST /api/playlist/import — create a playlist from an exported document. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { importPlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/playlist/import', 'write', async ({ user, request }) => {
  const playlist = await importPlaylist(user.id, await readJsonBody(request));
  return apiSuccess({ id: playlist.id, name: playlist.name, trackCount: playlist.trackCount });
});

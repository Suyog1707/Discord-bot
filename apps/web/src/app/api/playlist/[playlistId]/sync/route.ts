/** POST /api/playlist/:playlistId/sync — re-sync a Spotify-imported playlist. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { syncSpotifyPlaylist } from '@/lib/services/spotify';

export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ playlistId: string }>(
  'POST /api/playlist/:playlistId/sync',
  'write',
  async ({ user, params }) => apiSuccess(await syncSpotifyPlaylist(user.id, params.playlistId)),
);

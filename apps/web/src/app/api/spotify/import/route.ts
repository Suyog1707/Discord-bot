/** POST /api/spotify/import — import a Spotify playlist (or Liked Songs). */
import { parseOrThrow, z } from '@discord-music/shared';

import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { importSpotifyItem } from '@/lib/services/spotify';

export const dynamic = 'force-dynamic';

const importSchema = z.object({
  spotifyId: z.string().min(1).max(80),
});

export const POST = authedRoute('POST /api/spotify/import', 'write', async ({ user, request }) => {
  const { spotifyId } = parseOrThrow(importSchema, await readJsonBody(request));
  return apiSuccess(await importSpotifyItem(user.id, spotifyId));
});

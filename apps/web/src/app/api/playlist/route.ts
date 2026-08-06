/** /api/playlist — GET: list own playlists. POST: create one. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { createPlaylist, listPlaylists } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/playlist', 'read', async ({ user }) =>
  apiSuccess(await listPlaylists(user.id)),
);

export const POST = authedRoute('POST /api/playlist', 'write', async ({ user, request }) =>
  apiSuccess(await createPlaylist(user.id, await readJsonBody(request)), { status: 201 }),
);

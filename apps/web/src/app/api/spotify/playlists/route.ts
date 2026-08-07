/** GET /api/spotify/playlists — the linked account's importable items. */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { listImportable } from '@/lib/services/spotify';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/spotify/playlists', 'read', async ({ user }) =>
  apiSuccess(await listImportable(user.id)),
);

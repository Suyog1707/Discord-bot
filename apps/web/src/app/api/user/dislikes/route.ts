/**
 * GET  /api/user/dislikes — the signed-in listener's rejected songs.
 * POST /api/user/dislikes — reject a song.
 *
 * The POST body is `{ title, author, isrc?, trackKey?, guildId?, skipIfPlaying? }`.
 * With `guildId` the dislike is also pushed to that guild's live player, so a
 * thumbs-down on the now-playing track stops it; without one it is recorded and
 * takes effect on the bot's next autoplay generation.
 *
 * Unlike `/api/player/*` this needs no Manage Server permission: rejecting a
 * song only changes what gets recommended to the person who rejected it.
 */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { addDislikeForUser, listDislikes } from '@/lib/services/dislikes';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/user/dislikes', 'read', async ({ user }) =>
  apiSuccess(await listDislikes(user)),
);

export const POST = authedRoute('POST /api/user/dislikes', 'write', async ({ user, request }) =>
  apiSuccess(await addDislikeForUser(user, await readJsonBody(request))),
);

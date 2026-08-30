/**
 * GET  /api/user/dislikes — the signed-in listener's rejected songs, paged.
 * POST /api/user/dislikes — reject a song.
 *
 * `GET` takes `?limit=` (1..100, default 50) and `?cursor=` (the previous
 * page's `nextCursor`) and answers `{ items, nextCursor, total? }`. `total` is
 * only on the first page — it is there to show the distance to the 500-dislike
 * cap, not to be recounted per page.
 *
 * The POST body is `{ title, author, isrc?, trackKey?, guildId?, skipIfPlaying? }`.
 * With `guildId` the dislike is also pushed to that guild's live player, so a
 * thumbs-down on the now-playing track stops it; without one it is recorded and
 * takes effect on the bot's next autoplay generation.
 *
 * Unlike `/api/player/*` this needs no Manage Server permission: rejecting a
 * song only changes what gets recommended to the person who rejected it.
 */
import { parseOrThrow } from '@discord-music/shared';

import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import {
  addDislikeForUser,
  dislikePageQuerySchema,
  pageDislikesForUser,
} from '@/lib/services/dislikes';

export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/user/dislikes', 'read', async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const cursor = params.get('cursor');
  const limit = params.get('limit');

  // An absent parameter and an empty one mean the same thing here — a bare
  // `?cursor=` from a client that always appends its state is "no cursor", not
  // a validation error.
  const query = parseOrThrow(dislikePageQuerySchema, {
    ...(cursor === null || cursor === '' ? {} : { cursor }),
    ...(limit === null || limit === '' ? {} : { limit }),
  });

  return apiSuccess(await pageDislikesForUser(user, query));
});

export const POST = authedRoute('POST /api/user/dislikes', 'write', async ({ user, request }) =>
  apiSuccess(await addDislikeForUser(user, await readJsonBody(request))),
);

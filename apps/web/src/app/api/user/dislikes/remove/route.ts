/**
 * POST /api/user/dislikes/remove — un-reject several songs at once.
 *
 * Body: `{ trackKeys: string[] (1..100), guildId? }` → `{ removed }`, the
 * number of the caller's own rows that went away. Keys that were never theirs,
 * or were already gone, count as nothing removed rather than as an error, so a
 * resubmitted purge is safe.
 *
 * A POST rather than a `DELETE` with a body: bodies on `DELETE` are ignored by
 * enough of the stack (fetch, proxies, Next's own helpers) that the safe way to
 * send a list is a POST. The single-key `DELETE /api/user/dislikes/:trackKey`
 * stays for the per-row button.
 *
 * With `guildId` a *small* removal is also relayed to that guild's live player;
 * a large purge is not — see `removeDislikesForUser`.
 */
import { parseOrThrow } from '@discord-music/shared';

import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { dislikeRemoveInputSchema, removeDislikesForUser } from '@/lib/services/dislikes';

export const dynamic = 'force-dynamic';

export const POST = authedRoute(
  'POST /api/user/dislikes/remove',
  'write',
  async ({ user, request }) => {
    const body = parseOrThrow(dislikeRemoveInputSchema, await readJsonBody(request));
    const removed = await removeDislikesForUser(user, body.trackKeys, body.guildId);
    return apiSuccess({ removed });
  },
);

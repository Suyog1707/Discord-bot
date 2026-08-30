/**
 * DELETE /api/user/dislikes/:trackKey — un-reject a song.
 *
 * The key is a canonical identity (`artist::title`), not an id: it contains
 * separators and arbitrary punctuation, so it travels URL-encoded; Next decodes
 * the dynamic segment before it reaches this handler. An optional `?guildId=` also tells that guild's live player to
 * forget it straight away.
 */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { removeDislikeForUser } from '@/lib/services/dislikes';

export const dynamic = 'force-dynamic';

export const DELETE = authedRoute<{ trackKey: string }>(
  'DELETE /api/user/dislikes/:trackKey',
  'write',
  async ({ user, request, params }) => {
    const guildId = request.nextUrl.searchParams.get('guildId') ?? undefined;
    const removed = await removeDislikeForUser(user, params.trackKey, guildId);
    return apiSuccess({ removed });
  },
);

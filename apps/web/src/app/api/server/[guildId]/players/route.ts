/**
 * GET /api/server/:guildId/players — which player bots this server has.
 *
 * Polled by the invite button while a newly added player is still joining;
 * a page reload would work too, but the button exists so nobody has to.
 */
import { apiSuccess } from '@/lib/api';
import { authedRoute } from '@/lib/api-route';
import { listServerPlayers } from '@/lib/services/guilds';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ guildId: string }>(
  'GET /api/server/:guildId/players',
  'read',
  async ({ user, params }) => apiSuccess(await listServerPlayers(user.id, params.guildId)),
);

/** PATCH /api/server/:guildId/settings — update guild settings. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { updateGuildSettings } from '@/lib/services/guilds';

export const dynamic = 'force-dynamic';

export const PATCH = authedRoute<{ guildId: string }>(
  'PATCH /api/server/:guildId/settings',
  'write',
  async ({ user, request, params }) =>
    apiSuccess(await updateGuildSettings(user.id, params.guildId, await readJsonBody(request))),
);

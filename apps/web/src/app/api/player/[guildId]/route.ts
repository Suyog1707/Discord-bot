/** POST /api/player/:guildId — live playback control, relayed to the bot. */
import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { sendPlayerCommand } from '@/lib/services/player';

export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ guildId: string }>(
  'POST /api/player/:guildId',
  'control',
  async ({ user, request, params }) => {
    const action = await sendPlayerCommand(
      user.id,
      user.discordId,
      params.guildId,
      await readJsonBody(request),
    );
    return apiSuccess({ accepted: true, action });
  },
);

/**
 * POST /api/player/:guildId — live playback control, relayed to the bot.
 *
 * The body names the room: a server can be playing in several voice channels
 * at once, and a dashboard open on one must not reach into another.
 */
import { ValidationError } from '@discord-music/shared';

import { apiSuccess } from '@/lib/api';
import { authedRoute, readJsonBody } from '@/lib/api-route';
import { sendPlayerCommand } from '@/lib/services/player';

export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ guildId: string }>(
  'POST /api/player/:guildId',
  'control',
  async ({ user, request, params }) => {
    const body = await readJsonBody(request);
    const voiceChannelId =
      typeof body === 'object' && body !== null && 'voiceChannelId' in body
        ? (body as { voiceChannelId?: unknown }).voiceChannelId
        : undefined;
    if (typeof voiceChannelId !== 'string' || voiceChannelId === '') {
      throw new ValidationError('voiceChannelId is required — commands name the room they act on.');
    }

    const action = await sendPlayerCommand(
      user.id,
      user.discordId,
      params.guildId,
      voiceChannelId,
      body,
    );
    return apiSuccess({ accepted: true, action });
  },
);

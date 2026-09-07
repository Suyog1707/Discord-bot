/** `/volume` — set playback volume for this session. */
import { LIMITS, parseOrThrow, volumeSchema } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume.')
    .addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription(`Volume (${String(LIMITS.VOLUME_MIN)}–${String(LIMITS.VOLUME_MAX)})`)
        .setMinValue(LIMITS.VOLUME_MIN)
        .setMaxValue(LIMITS.VOLUME_MAX)
        .setRequired(true),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));

    const percent = parseOrThrow(volumeSchema, interaction.options.getInteger('percent', true));
    await player.setVolume(percent);

    await interaction.editReply({
      content: `🔊 Volume set to **${String(percent)}%**.`,
    });
  },
});

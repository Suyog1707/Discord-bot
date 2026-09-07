/** `/resume` — resume paused playback. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume paused playback.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));

    if (!player.paused) {
      await interaction.editReply({
        content: 'Playback is not paused.',
      });
      return;
    }

    await player.resume();
    await interaction.editReply({ content: '▶️ Resumed.' });
  },
});

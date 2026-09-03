/** `/pause` — pause playback. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    if (player.paused) {
      await interaction.editReply({
        content: 'Already paused — use `/resume`.',
      });
      return;
    }

    await player.pause();
    await interaction.editReply({
      content: '⏸️ Paused. Use `/resume` to continue.',
    });
  },
});

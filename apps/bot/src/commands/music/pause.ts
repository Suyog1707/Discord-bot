/** `/pause` — pause playback. */
import { MessageFlags } from 'discord.js';

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
      await interaction.reply({
        content: 'Already paused — use `/resume`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await player.pause();
    await interaction.reply({
      content: '⏸️ Paused. Use `/resume` to continue.',
      flags: MessageFlags.Ephemeral,
    });
  },
});

/** `/stop` — stop playback and clear the queue (stays in the channel). */
import { MessageFlags } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    await player.stop();
    await interaction.reply({
      content: '⏹️ Stopped and cleared the queue.',
      flags: MessageFlags.Ephemeral,
    });
  },
});

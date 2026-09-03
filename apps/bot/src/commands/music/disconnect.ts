/** `/disconnect` — leave the voice channel entirely. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot from voice and clear the queue.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const context = requireVoiceContext(interaction);
    requireActivePlayer(music, context);

    await music.destroyPlayer(context.guildId);
    await interaction.editReply({ content: '👋 Disconnected.' });
  },
});

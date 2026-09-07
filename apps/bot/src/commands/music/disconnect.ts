/** `/disconnect` — leave the voice channel entirely. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireRouter,
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
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);
    requireActivePlayer(router, context);

    // Only the caller's room leaves; any other channel this server has
    // playing carries on untouched.
    await router.leaveRoom(context.guildId, context.voiceChannelId);
    await interaction.editReply({ content: '👋 Disconnected.' });
  },
});

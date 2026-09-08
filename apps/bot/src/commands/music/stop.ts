/** `/stop` — stop playback and clear the queue (stays in the channel). */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  intentTarget,
  runRoomIntent,
  requireRouter,
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
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);

    const result = await runRoomIntent(router, interaction, {
      action: 'stop',
      ...intentTarget(context, interaction.user.id),
    });
    if (result === null) return;

    await interaction.editReply({ content: '⏹️ Stopped and cleared the queue.' });
  },
});

/** `/resume` — resume paused playback. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  intentTarget,
  runRoomIntent,
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
    const context = requireVoiceContext(interaction);

    const result = await runRoomIntent(router, interaction, {
      action: 'resume',
      ...intentTarget(context, interaction.user.id),
    });
    if (result === null) return;

    await interaction.editReply({ content: '▶️ Resumed.' });
  },
});

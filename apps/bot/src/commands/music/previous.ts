/** `/previous` — go back to the previously played track. */
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
    .setName('previous')
    .setDescription('Play the previous track again.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);

    const result = await runRoomIntent(router, interaction, {
      action: 'previous',
      ...intentTarget(context, interaction.user.id),
    });
    if (result === null) return;

    const title = result.kind === 'track' ? (result.track?.title ?? 'the previous track') : '';
    await interaction.editReply({ content: `⏮️ Back to **${title}**.` });
  },
});

/** `/shuffle` — shuffle the upcoming tracks. */
import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  intentTarget,
  runRoomIntent,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming tracks.'),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);

    const result = await runRoomIntent(router, interaction, {
      action: 'shuffle',
      ...intentTarget(context, interaction.user.id),
    });
    if (result === null) return;

    const count = result.kind === 'count' ? result.count : 0;
    await interaction.editReply({
      content:
        count < 2
          ? 'Nothing to shuffle — the queue has fewer than two upcoming tracks.'
          : `🔀 Shuffled **${String(count)}** upcoming tracks.`,
    });
  },
});

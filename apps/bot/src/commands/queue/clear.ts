/** `/clear` — drop every upcoming track, keep the current one playing. */
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
    .setName('clear')
    .setDescription('Clear all upcoming tracks (the current track keeps playing).'),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);

    const result = await runRoomIntent(router, interaction, {
      action: 'clear',
      ...intentTarget(context, interaction.user.id),
    });
    if (result === null) return;

    const count = result.kind === 'count' ? result.count : 0;
    await interaction.editReply({
      content:
        count === 0
          ? 'The queue was already empty.'
          : `🗑️ Cleared **${String(count)}** upcoming track${count === 1 ? '' : 's'}.`,
    });
  },
});

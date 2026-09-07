/** `/swap` — swap two upcoming tracks. */
import { ValidationError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('swap')
    .setDescription('Swap two tracks in the queue.')
    .addIntegerOption((option) =>
      option
        .setName('first')
        .setDescription('First position as shown by /queue')
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('second')
        .setDescription('Second position as shown by /queue')
        .setMinValue(1)
        .setRequired(true),
    ),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));

    const first = interaction.options.getInteger('first', true);
    const second = interaction.options.getInteger('second', true);

    if (!player.swapUpcoming(first - 1, second - 1)) {
      throw new ValidationError(
        `Positions must be within the ${String(player.queue.upcoming.length)} upcoming track(s).`,
      );
    }

    await interaction.editReply({
      content: `🔀 Swapped positions ${String(first)} and ${String(second)}.`,
    });
  },
});

/** `/remove` — remove one upcoming track by its queue position. */
import { ValidationError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue.')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Queue position as shown by /queue (1 = next up)')
        .setMinValue(1)
        .setRequired(true),
    ),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const position = interaction.options.getInteger('position', true);
    const removed = player.removeUpcoming(position - 1);

    if (removed === null) {
      throw new ValidationError(
        `Nothing at position ${String(position)} — the queue has ${String(player.queue.upcoming.length)} upcoming track(s).`,
      );
    }

    await interaction.editReply({
      content: `🗑️ Removed **${removed.title}**.`,
    });
  },
});

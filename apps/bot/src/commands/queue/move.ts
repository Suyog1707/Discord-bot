/** `/move` — move an upcoming track to another position. */
import { ValidationError } from '@discord-music/shared';
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
    .setName('move')
    .setDescription('Move a track to a different position in the queue.')
    .addIntegerOption((option) =>
      option
        .setName('from')
        .setDescription('Current position as shown by /queue')
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('to')
        .setDescription('New position (1 = next up)')
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

    const from = interaction.options.getInteger('from', true);
    const to = interaction.options.getInteger('to', true);
    const moved = player.moveUpcoming(from - 1, to - 1);

    if (moved === null) {
      throw new ValidationError(
        `Positions must be within the ${String(player.queue.upcoming.length)} upcoming track(s).`,
      );
    }

    await interaction.reply({
      content: `↕️ Moved **${moved.title}** to position ${String(to)}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
});

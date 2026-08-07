/** `/jump` — jump straight to an upcoming track. */
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
    .setName('jump')
    .setDescription('Jump to a track in the queue.')
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
    const target = await player.jumpTo(player.queue.currentIndex + position);

    if (target === null) {
      throw new ValidationError(
        `Nothing at position ${String(position)} — the queue has ${String(player.queue.upcoming.length)} upcoming track(s).`,
      );
    }

    await interaction.reply({
      content: `⏩ Jumped to **${target.title}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
});

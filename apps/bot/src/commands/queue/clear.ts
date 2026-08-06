/** `/clear` — drop every upcoming track, keep the current one playing. */
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
    .setName('clear')
    .setDescription('Clear all upcoming tracks (the current track keeps playing).'),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const removed = player.clearUpcoming();
    if (removed === 0) {
      throw new ValidationError('There are no upcoming tracks to clear.');
    }

    await interaction.reply({
      content: `🧹 Cleared **${String(removed)}** upcoming track(s).`,
      flags: MessageFlags.Ephemeral,
    });
  },
});

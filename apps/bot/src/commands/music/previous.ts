/** `/previous` — go back to the previously played track. */
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
    .setName('previous')
    .setDescription('Play the previous track again.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const track = await player.previous();
    if (track === null) {
      throw new ValidationError('There is no earlier track — this is the start of the queue.');
    }

    await interaction.editReply({
      content: `⏮️ Back to **${track.title}**.`,
    });
  },
});

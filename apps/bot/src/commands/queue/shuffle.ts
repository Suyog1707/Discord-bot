/** `/shuffle` — shuffle the upcoming tracks. */
import { ValidationError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
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
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    if (player.queue.upcoming.length < 2) {
      throw new ValidationError('Not enough upcoming tracks to shuffle.');
    }

    player.shuffle();
    await interaction.editReply({
      content: `🔀 Shuffled **${String(player.queue.upcoming.length)}** tracks.`,
    });
  },
});

/** `/restart` — restart the current track from the beginning. */
import { NotFoundError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the current track from the beginning.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const track = await player.restart();
    if (track === null) {
      throw new NotFoundError('Nothing is playing right now.');
    }

    await interaction.editReply({
      content: `🔄 Restarted **${track.title}**.`,
    });
  },
});

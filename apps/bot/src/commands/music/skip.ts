/** `/skip` — skip the current track. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const skipped = player.queue.current;
    await player.skip();

    await interaction.editReply({
      content: skipped === null ? 'Skipped.' : `⏭️ Skipped **${skipped.title}**.`,
    });
  },
});

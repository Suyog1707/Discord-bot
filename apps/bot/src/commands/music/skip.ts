/** `/skip` — skip the current track. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  denyUnlessDjOrOwnTrack,
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
  // Skipping your own song needs no permission from anybody.
  ownTrackExempt: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const skipped = player.queue.current;

    const denial = await denyUnlessDjOrOwnTrack(interaction, skipped);
    if (denial !== null) {
      await interaction.editReply({ content: denial });
      return;
    }

    await player.skip();

    await interaction.editReply({
      content: skipped === null ? 'Skipped.' : `⏭️ Skipped **${skipped.title}**.`,
    });
  },
});

/** `/nowplaying` — details, progress and transport buttons for the current track. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { renderNowPlaying } from '../../music/now-playing-view.js';
import { requireMusic } from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what is currently playing.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = interaction.guildId === null ? undefined : music.getPlayer(interaction.guildId);

    if (player?.queue.current == null) {
      await interaction.editReply({ content: 'Nothing is playing.' });
      return;
    }

    const view = renderNowPlaying(player);
    await interaction.editReply({ ...view });
  },
});

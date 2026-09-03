/** `/lyrics` — lyrics for the current track (LRCLIB). */
import { NotFoundError } from '@discord-music/shared';
import { EmbedBuilder } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { fetchLyrics } from '../../music/lyrics.js';
import { requireMusic } from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics for the current track.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 5,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = interaction.guildId === null ? undefined : music.getPlayer(interaction.guildId);
    const current = player?.queue.current ?? null;
    if (current === null) throw new NotFoundError('Nothing is playing.');

    const result = await fetchLyrics(current.title, current.author);
    if (result === null) {
      await interaction.editReply(
        `No lyrics found for **${current.title}** — instrumentals, remixes and obscure uploads often have none.`,
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Lyrics' })
      .setTitle(`${current.title} — ${current.author}`)
      .setDescription(result.lyrics)
      .setFooter({ text: 'Lyrics from LRCLIB' });

    await interaction.editReply({ embeds: [embed] });
  },
});

/** `/history` — recently played tracks in this server. */
import { NotFoundError } from '@discord-music/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration } from '../../music/track.js';

const HISTORY_PAGE = 15;

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show recently played tracks in this server.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 5,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;

    const rows = await client.prisma.songHistory.findMany({
      where: { guild: { discordId: interaction.guildId ?? '' } },
      orderBy: { playedAt: 'desc' },
      take: HISTORY_PAGE,
      select: { title: true, author: true, durationMs: true, skipped: true, playedAt: true },
    });
    if (rows.length === 0) {
      throw new NotFoundError('Nothing has been played here yet.');
    }

    const lines = rows.map((row, index) => {
      const duration = formatTrackDuration({ durationMs: row.durationMs, isStream: false });
      const skipped = row.skipped ? ' · ⏭️ skipped' : '';
      return `**${String(index + 1)}.** ${row.title} — ${row.author} (${duration})${skipped}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Recently played' })
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Last ${String(rows.length)} tracks` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
});

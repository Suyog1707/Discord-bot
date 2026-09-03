/** `/stats` — runtime health: uptime, servers, memory, latency. */
import { EmbedBuilder, version as discordJsVersion } from 'discord.js';

import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  parts.push(`${String(minutes)}m`);
  return parts.join(' ');
}

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription("View the bot's uptime, server count and resource usage."),
  category: 'general',
  cooldownSeconds: 10,

  async execute({ interaction }) {
    const { client } = interaction;
    const memoryMb = process.memoryUsage.rss() / 1024 / 1024;
    const websocketMs = Math.round(client.ws.ping);

    const embed = new EmbedBuilder()
      .setTitle('Bot statistics')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
        { name: 'Servers', value: String(client.guilds.cache.size), inline: true },
        {
          name: 'Latency',
          value: websocketMs < 0 ? 'measuring…' : `${String(websocketMs)}ms`,
          inline: true,
        },
        { name: 'Memory', value: `${memoryMb.toFixed(0)} MB`, inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'discord.js', value: `v${discordJsVersion}`, inline: true },
      );

    await interaction.editReply({ embeds: [embed] });
  },
});

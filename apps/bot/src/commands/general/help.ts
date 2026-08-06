/** `/help` — command list grouped by category, built from the live registry. */
import { EmbedBuilder, MessageFlags } from 'discord.js';

import { COMMAND_CATEGORIES, defineCommand, SlashCommandBuilder } from '../../core/command.js';
import type { BotClient } from '../../core/bot-client.js';

const CATEGORY_LABELS: Record<(typeof COMMAND_CATEGORIES)[number], string> = {
  general: '🧭 General',
  music: '🎵 Music',
  queue: '📜 Queue',
  playlist: '💾 Playlists',
  settings: '⚙️ Settings',
};

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List every available command, grouped by category.'),
  category: 'general',
  cooldownSeconds: 5,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;

    const embed = new EmbedBuilder()
      .setTitle('Commands')
      .setColor(0x5865f2)
      .setDescription('Everything the bot can do. Commands marked DJ-only need the DJ role.');

    for (const category of COMMAND_CATEGORIES) {
      const commands = client.commands
        .values()
        .filter((command) => command.category === category && command.devOnly !== true);
      if (commands.length === 0) continue;

      embed.addFields({
        name: CATEGORY_LABELS[category],
        value: commands
          .map(
            (command) =>
              `**/${command.data.name}**${command.djOnly === true ? ' *(DJ)*' : ''} — ${command.data.description}`,
          )
          .join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
});

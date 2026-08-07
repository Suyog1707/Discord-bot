/** `/autoplay` — continue with similar tracks when the queue ends. */
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Toggle smart autoplay: keep playing similar tracks when the queue ends.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((option) =>
      option.setName('enabled').setDescription('On or off (omit to toggle)').setRequired(false),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  userPermissions: [PermissionFlagsBits.ManageGuild],

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const guildId = interaction.guildId ?? '';
    const settings = await client.services.guilds.getSettings(guildId);

    const enabled = interaction.options.getBoolean('enabled') ?? !settings.autoplayEnabled;
    await client.services.guilds.updateSettings(guildId, { autoplayEnabled: enabled });
    client.music?.getPlayer(guildId)?.setAutoplayEnabled(enabled);

    await interaction.reply({
      content: enabled
        ? '📻 **Autoplay on** — when the queue ends I will continue with similar tracks based on what was playing.'
        : '📻 **Autoplay off** — playback stops when the queue ends.',
      flags: MessageFlags.Ephemeral,
    });
  },
});

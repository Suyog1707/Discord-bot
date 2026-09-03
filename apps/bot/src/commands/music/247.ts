/** `/247` — keep the bot in the voice channel around the clock. */
import { PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('247')
    .setDescription('Toggle 24/7 mode: stay in the voice channel and survive restarts.')
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

    const enabled = interaction.options.getBoolean('enabled') ?? !settings.stayConnected;
    await client.services.guilds.updateSettings(guildId, { stayConnected: enabled });

    // Apply to a live player immediately; otherwise it takes effect on join.
    client.music?.getPlayer(guildId)?.setStayConnected(enabled);

    await interaction.editReply({
      content: enabled
        ? '🔁 **24/7 mode on** — I will stay in the voice channel and rejoin after restarts.'
        : `🔁 **24/7 mode off** — I will leave after ${String(settings.leaveOnEmptyAfter)}s of inactivity.`,
    });
  },
});

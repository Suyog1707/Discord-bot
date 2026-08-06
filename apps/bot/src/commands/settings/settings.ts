/**
 * `/settings` — per-guild configuration (docs/DISCORD_BOT.md, GuildSettings model).
 *
 * Subcommands:
 *   view                      Show current settings.
 *   volume <percent>          Default playback volume (0–200).
 *   dj-role <role> | clear    Restrict music control to a role, or open it up.
 *   announce <enabled>        Toggle now-playing announcements.
 *   auto-leave <seconds>      Leave voice after N seconds idle (60–3600).
 *
 * Requires Manage Server. All writes go through GuildService.
 */
import { LIMITS, parseOrThrow, volumeSchema, z } from '@discord-music/shared';
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

const autoLeaveSchema = z.number().int().min(60).max(3600);

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('View or change this server’s bot settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the current settings.'))
    .addSubcommand((sub) =>
      sub
        .setName('volume')
        .setDescription('Set the default playback volume.')
        .addIntegerOption((option) =>
          option
            .setName('percent')
            .setDescription(
              `Volume percent (${String(LIMITS.VOLUME_MIN)}–${String(LIMITS.VOLUME_MAX)})`,
            )
            .setMinValue(LIMITS.VOLUME_MIN)
            .setMaxValue(LIMITS.VOLUME_MAX)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('dj-role')
        .setDescription('Restrict music commands to a DJ role, or clear the restriction.')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The DJ role. Omit to clear.').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('announce')
        .setDescription('Toggle now-playing announcements.')
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('Announce tracks as they start')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('auto-leave')
        .setDescription('How long to stay in an empty voice channel.')
        .addIntegerOption((option) =>
          option
            .setName('seconds')
            .setDescription('Seconds of inactivity before leaving (60–3600)')
            .setMinValue(60)
            .setMaxValue(3600)
            .setRequired(true),
        ),
    ),
  category: 'settings',
  guildOnly: true,
  cooldownSeconds: 3,
  userPermissions: [PermissionFlagsBits.ManageGuild],

  async execute({ interaction }) {
    const { guildId } = interaction;
    if (guildId === null) return; // Unreachable: the guildOnly guard rejected DMs already.
    const client = interaction.client as BotClient;
    const guilds = client.services.guilds;
    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case 'view': {
        const settings = await guilds.getSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle('Server settings')
          .setColor(0x5865f2)
          .addFields(
            { name: 'Default volume', value: `${String(settings.defaultVolume)}%`, inline: true },
            {
              name: 'DJ role',
              value: settings.djRoleId === null ? 'None (everyone)' : `<@&${settings.djRoleId}>`,
              inline: true,
            },
            {
              name: 'Announce now playing',
              value: settings.announceNowPlaying ? 'On' : 'Off',
              inline: true,
            },
            {
              name: 'Auto-leave',
              value: `${String(settings.leaveOnEmptyAfter)}s idle`,
              inline: true,
            },
          );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'volume': {
        // Discord validates min/max client-side; parse again server-side anyway.
        const percent = parseOrThrow(volumeSchema, interaction.options.getInteger('percent', true));
        await guilds.updateSettings(guildId, { defaultVolume: percent });
        await interaction.reply({
          content: `Default volume set to **${String(percent)}%**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'dj-role': {
        const role = interaction.options.getRole('role');
        await guilds.updateSettings(guildId, { djRoleId: role?.id ?? null });
        await interaction.reply({
          content:
            role === null
              ? 'DJ restriction cleared — everyone can control music.'
              : `Music control restricted to <@&${role.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'announce': {
        const enabled = interaction.options.getBoolean('enabled', true);
        await guilds.updateSettings(guildId, { announceNowPlaying: enabled });
        await interaction.reply({
          content: `Now-playing announcements **${enabled ? 'enabled' : 'disabled'}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'auto-leave': {
        const seconds = parseOrThrow(
          autoLeaveSchema,
          interaction.options.getInteger('seconds', true),
        );
        await guilds.updateSettings(guildId, { leaveOnEmptyAfter: seconds });
        await interaction.reply({
          content: `I'll leave voice after **${String(seconds)}s** of inactivity.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      default: {
        await interaction.reply({
          content: 'Unknown settings subcommand.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
});

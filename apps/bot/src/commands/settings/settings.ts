/**
 * `/settings` — per-guild configuration (docs/DISCORD_BOT.md, GuildSettings model).
 *
 * Subcommands:
 *   view                      Show current settings.
 *   volume <percent>          Default playback volume (0–200).
 *   dj-role <role> | clear    Restrict music control to a role, or open it up.
 *   dj-user <add|remove> <user>  Name individuals as standing DJs.
 *   announce <enabled>        Toggle now-playing announcements.
 *   auto-leave <seconds>      Leave voice after N seconds idle (60–3600).
 *
 * Requires Manage Server. All writes go through GuildService.
 */
import { LIMITS, parseOrThrow, volumeSchema, z } from '@discord-music/shared';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

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
        .setName('dj-user')
        .setDescription('Give or take standing DJ from one person.')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('Add or remove')
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('Who to add or remove').setRequired(true),
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
              value: settings.djRoleId === null ? 'None' : `<@&${settings.djRoleId}>`,
              inline: true,
            },
            {
              name: 'Named DJs',
              value:
                settings.djUserIds.length === 0
                  ? 'None'
                  : settings.djUserIds.map((id) => `<@${id}>`).join(', '),
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
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      case 'volume': {
        // Discord validates min/max client-side; parse again server-side anyway.
        const percent = parseOrThrow(volumeSchema, interaction.options.getInteger('percent', true));
        await guilds.updateSettings(guildId, { defaultVolume: percent });
        await interaction.editReply({
          content: `Default volume set to **${String(percent)}%**.`,
        });
        return;
      }

      case 'dj-role': {
        const role = interaction.options.getRole('role');
        await guilds.updateSettings(guildId, { djRoleId: role?.id ?? null });
        await interaction.editReply({
          content:
            role === null
              ? 'DJ role cleared. Whoever starts the music still hosts the session and can share control with `/dj add`.'
              : `<@&${role.id}> can control music — while they are in the voice channel the bot is playing in.`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      case 'dj-user': {
        const action = interaction.options.getString('action', true);
        const user = interaction.options.getUser('user', true);
        const current = (await guilds.getSettings(guildId)).djUserIds;

        // Standing DJs are a set; adding twice must not grow the column, and
        // removing someone who was never there is not an error worth raising.
        const next =
          action === 'add'
            ? [...new Set([...current, user.id])]
            : current.filter((id) => id !== user.id);

        if (next.length === current.length && action === 'add') {
          await interaction.editReply({ content: `**${user.username}** is already a DJ.` });
          return;
        }
        await guilds.updateSettings(guildId, { djUserIds: next });
        await interaction.editReply({
          content:
            action === 'add'
              ? `**${user.username}** is now a DJ — in whichever voice channel the bot is playing in.`
              : `**${user.username}** is no longer a standing DJ.`,
        });
        return;
      }

      case 'announce': {
        const enabled = interaction.options.getBoolean('enabled', true);
        await guilds.updateSettings(guildId, { announceNowPlaying: enabled });
        await interaction.editReply({
          content: `Now-playing announcements **${enabled ? 'enabled' : 'disabled'}**.`,
        });
        return;
      }

      case 'auto-leave': {
        const seconds = parseOrThrow(
          autoLeaveSchema,
          interaction.options.getInteger('seconds', true),
        );
        await guilds.updateSettings(guildId, { leaveOnEmptyAfter: seconds });
        await interaction.editReply({
          content: `I'll leave voice after **${String(seconds)}s** of inactivity.`,
        });
        return;
      }

      default: {
        await interaction.editReply({
          content: 'Unknown settings subcommand.',
        });
      }
    }
  },
});

/** `/autoplay` — continue with personalised tracks when the queue ends, and who it plays for. */
import { PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Smart autoplay: keep playing songs you like when the queue ends.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('toggle')
        .setDescription('Turn autoplay on or off.')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('On or off (omit to toggle)').setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('claim')
        .setDescription(
          'Make autoplay follow YOUR taste — history, favorites, playlists, dislikes.',
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('listener').setDescription('Show whose taste autoplay is following.'),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const guildId = interaction.guildId ?? '';
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === 'claim') {
      // Changing whose taste a shared radio follows is a voice action: the
      // claimant must be in the channel the music is playing in.
      const router = requireRouter(client);
      const player = requireActivePlayer(router, requireVoiceContext(interaction));
      player.setListener(interaction.user.id);
      await interaction.editReply({
        content: `🎧 Autoplay now follows **${interaction.user.username}**'s taste.`,
      });
      return;
    }

    if (subcommand === 'listener') {
      const listener = client.music?.getPlayer(guildId)?.listenerId ?? null;
      await interaction.editReply({
        content:
          listener === null
            ? '🎧 Nobody has claimed autoplay yet — the first person to request a song owns it, or use `/autoplay claim`.'
            : `🎧 Autoplay follows <@${listener}>'s taste. Use \`/autoplay claim\` to make it follow yours.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // toggle — a guild-level setting, as before.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply({
        content: 'You need **Manage Server** to turn autoplay on or off.',
      });
      return;
    }
    const settings = await client.services.guilds.getSettings(guildId);
    const enabled = interaction.options.getBoolean('enabled') ?? !settings.autoplayEnabled;
    await client.services.guilds.updateSettings(guildId, { autoplayEnabled: enabled });
    client.music?.getPlayer(guildId)?.setAutoplayEnabled(enabled);

    await interaction.editReply({
      content: enabled
        ? '📻 **Autoplay on** — recommendations stay in the language of your latest requested song. If the language is unknown or no matching tracks are available, playback stops instead of switching languages.'
        : '📻 **Autoplay off** — playback stops when the queue ends.',
    });
  },
});

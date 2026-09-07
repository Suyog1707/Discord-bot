/** `/dj` — share control of the current session with people in the channel. */
import { PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Share control of this session with people in the voice channel.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Give someone in the channel DJ for this session.')
        .addUserOption((option) =>
          option.setName('user').setDescription('Who to make a DJ').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Take back DJ from someone.')
        .addUserOption((option) =>
          option.setName('user').setDescription('Who to remove').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('Show who controls this session.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('claim')
        .setDescription('Take over a session whose host has left the channel.'),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const guildId = interaction.guildId ?? '';
    const registry = music.sessionDj;
    const subcommand = interaction.options.getSubcommand(true);

    // Every subcommand is about the session in the bot's channel, so the
    // caller has to be in it — the same rule the DJ gate itself applies.
    const player = requireActivePlayer(music, requireVoiceContext(interaction));
    const host = registry.host(guildId);
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;

    if (subcommand === 'list') {
      const djIds = registry.djIds(guildId);
      const lines = [
        host === null
          ? '**Host:** nobody yet — whoever plays the next song'
          : `**Host:** <@${host}>`,
        djIds.length === 0
          ? '**DJs:** nobody yet — the host can add some with `/dj add`'
          : `**DJs:** ${djIds.map((id) => `<@${id}>`).join(', ')}`,
        '',
        'Anyone in the channel can queue songs with `/play`, and can skip or remove their own.',
      ];
      await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
      return;
    }

    if (subcommand === 'claim') {
      /**
       * The escape hatch for an abandoned session: without it, a host who
       * disconnects takes the controls with them until the bot leaves.
       */
      if (host !== null && host !== interaction.user.id && !isAdmin) {
        const hostMember = await interaction.guild?.members.fetch(host).catch(() => null);
        if (hostMember?.voice.channelId === player.voiceChannelId) {
          await interaction.editReply({
            content: `<@${host}> is still here and hosting this session. Ask them for DJ with \`/dj add\`.`,
            allowedMentions: { parse: [] },
          });
          return;
        }
      }

      registry.claimHost(guildId, interaction.user.id);
      await interaction.editReply({
        content: `🎛️ **${interaction.user.username}** now hosts this session.`,
      });
      return;
    }

    // add / remove are the host's to give, with admins as the usual valve.
    if (host !== null && host !== interaction.user.id && !isAdmin) {
      await interaction.editReply({
        content: `Only <@${host}> can hand out DJ for this session.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const target = interaction.options.getUser('user', true);

    if (subcommand === 'remove') {
      const removed = registry.revoke(guildId, target.id);
      await interaction.editReply({
        content: removed
          ? `🎛️ **${target.username}** is no longer a DJ.`
          : `**${target.username}** was not a DJ.`,
      });
      return;
    }

    if (target.bot) {
      await interaction.editReply({ content: 'Bots cannot be DJs.' });
      return;
    }
    if (target.id === host) {
      await interaction.editReply({
        content: `<@${host}> already hosts this session.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // DJ is granted to the room, not to the server: whoever is being promoted
    // has to actually be listening.
    const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
    if (member?.voice.channelId !== player.voiceChannelId) {
      await interaction.editReply({
        content: `**${target.username}** has to be in the voice channel with the bot to become a DJ.`,
      });
      return;
    }

    registry.grant(guildId, target.id);
    await interaction.editReply({
      content: `🎛️ **${target.username}** is now a DJ for this session.`,
    });
  },
});

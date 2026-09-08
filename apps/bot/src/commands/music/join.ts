/** `/join` — bring the bot in and pick up the queue this channel was left with. */
import { EmbedBuilder } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { requireRouter, requireVoiceContext } from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and resume the queue it was left with.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  /**
   * Not DJ-gated, for the same reason `/play` is not: this is how a session
   * *starts*, and gating it would mean nobody could ever begin one.
   */
  deferral: 'public',

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const context = requireVoiceContext(interaction);

    // Joining restores whatever this channel was left with — that has always
    // happened, it was simply unreachable without naming a song. The room may
    // belong to another container, so everything after the join travels as one
    // intent rather than as a handful of reads.
    const room = await router.openRoom({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });

    const result = await router.runIntent({
      action: 'join-session',
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      issuedBy: interaction.user.id,
    });

    if (result.kind === 'error') {
      await interaction.editReply({ content: result.message });
      return;
    }
    if (result.kind !== 'joined') return;

    // Already here and playing: this is somebody's live session, so say so
    // rather than taking it over.
    if (result.outcome === 'already-playing') {
      await interaction.editReply({
        content: `Already playing in <#${context.voiceChannelId}>.`,
      });
      return;
    }

    if (result.outcome === 'empty' || result.current === null) {
      await interaction.editReply({
        content:
          `👋 Joined <#${context.voiceChannelId}>. Nothing is queued here — ` +
          'add something with `/play`.',
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('▶️ Resumed')
      .setDescription(`**${result.current.title}**\n${result.current.author}`)
      .addFields({
        name: 'Channel',
        value: `<#${context.voiceChannelId}>`,
        inline: true,
      });

    if (result.upcomingCount > 0) {
      embed.addFields({
        name: 'Up next',
        value: `${String(result.upcomingCount)} track${result.upcomingCount === 1 ? '' : 's'}`,
        inline: true,
      });
    }
    // One footer, built from whichever of these applies — a second setFooter
    // would silently replace the first.
    const notes: string[] = [];
    if (result.resumed !== null) {
      notes.push(
        `Picked up ${String(result.resumed.trackCount)} track${
          result.resumed.trackCount === 1 ? '' : 's'
        } this channel was left with.`,
      );
    }
    // Which bot answered matters when a server has several: the controls are on
    // that bot's message, in that channel, and nowhere else.
    if (room.local === undefined) notes.push(`Playing through ${room.botId}.`);
    if (notes.length > 0) embed.setFooter({ text: notes.join(' ') });

    await interaction.editReply({ embeds: [embed] });
  },
});

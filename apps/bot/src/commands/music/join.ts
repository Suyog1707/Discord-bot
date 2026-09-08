/** `/join` — bring the bot in and pick up the queue this channel was left with. */
import { EmbedBuilder } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import type { GuildPlayer } from '../../music/guild-player.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { decideJoin } from '../../music/join-decision.js';
import { requireRouter, requireVoiceContext } from '../../music/voice-context.js';

/** The three facts `decideJoin` needs, read off a live player. */
function stateOf(player: GuildPlayer): {
  readonly isPlaying: boolean;
  readonly hasCurrentTrack: boolean;
  readonly currentIndex: number;
} {
  return {
    isPlaying: player.isPlaying,
    hasCurrentTrack: player.queue.current !== null,
    currentIndex: player.queue.currentIndex,
  };
}

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

    // Already here and playing: this is somebody's live session, so say so
    // rather than rejoining and taking it over.
    const existing = router.playerFor(context.guildId, context.voiceChannelId);
    if (existing !== undefined && decideJoin(stateOf(existing)).kind === 'already-playing') {
      await interaction.editReply({
        content: `Already playing in <#${context.voiceChannelId}>.`,
      });
      return;
    }

    // Joining restores whatever this channel was left with — that has always
    // happened, it was simply unreachable without naming a song.
    const player = await router.joinRoom({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });

    const room = router.roomFor(context.guildId, context.voiceChannelId);
    const resumed = room?.music.takeResumeNotice(context.guildId) ?? null;

    /**
     * Whoever summons the bot runs the session.
     *
     * A restored queue remembers the listener it belonged to, but that person
     * may well have gone home — their taste should not quietly drive a room
     * they are not in. `setListener` moves autoplay to the caller and, through
     * `onListenerChange`, makes them host; `setHost` is first-writer-wins, so
     * naming them directly also covers the case where they *are* the restored
     * listener and `setListener` therefore has nothing to change.
     */
    player.setListener(interaction.user.id);
    room?.music.sessionDj.setHost(context.guildId, interaction.user.id);

    const decision = decideJoin(stateOf(player));
    const current = player.queue.current;
    if (decision.kind !== 'resume' || current === null) {
      await interaction.editReply({
        content:
          `👋 Joined <#${context.voiceChannelId}>. Nothing is queued here — ` +
          'add something with `/play`.',
      });
      return;
    }

    // The queue comes back on join; playback does not. Only `/play` ever
    // started it, as a side effect of enqueuing the track it was given.
    await player.jumpTo(decision.fromIndex);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('▶️ Resumed')
      .setDescription(`**${current.title}**\n${current.author}`)
      .addFields({
        name: 'Channel',
        value: `<#${context.voiceChannelId}>`,
        inline: true,
      });

    const upcoming = player.queue.upcoming.length;
    if (upcoming > 0) {
      embed.addFields({
        name: 'Up next',
        value: `${String(upcoming)} track${upcoming === 1 ? '' : 's'}`,
        inline: true,
      });
    }
    if (resumed !== null) {
      embed.setFooter({
        text: `Picked up ${String(resumed.trackCount)} track${
          resumed.trackCount === 1 ? '' : 's'
        } this channel was left with.`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
});

/** `/play` — resolve a URL or search query and queue the result. */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic, requireVoiceContext } from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track or playlist, or add it to the queue.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A URL (YouTube, Spotify, SoundCloud, Deezer) or a search term')
        .setRequired(true)
        .setMaxLength(500),
    )
    .addStringOption((option) =>
      option
        .setName('source')
        .setDescription('Where to search when the query is not a URL (default: YouTube)')
        .addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'SoundCloud', value: 'soundcloud' },
        ),
    )
    .addBooleanOption((option) =>
      option.setName('next').setDescription('Insert at the front of the queue'),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,
  botPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const context = requireVoiceContext(interaction);

    // Resolution + join can exceed the 3s interaction budget.
    await interaction.deferReply();

    const query = interaction.options.getString('query', true);
    const source = (interaction.options.getString('source') ?? 'youtube') as
      'youtube' | 'soundcloud';
    const insertNext = interaction.options.getBoolean('next') ?? false;

    const result = await music.resolve(
      query,
      {
        id: interaction.user.id,
        name:
          interaction.member !== null && 'displayName' in interaction.member
            ? interaction.member.displayName
            : interaction.user.username,
      },
      source,
    );

    const player = await music.getOrCreatePlayer({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });

    const { startedPlayback } = await player.enqueue(result.tracks, { next: insertNext });

    const [first] = result.tracks;
    if (first === undefined) return; // resolve() already threw on empty results

    const embed = new EmbedBuilder().setColor(0x5865f2);

    if (result.playlistName !== null) {
      embed
        .setAuthor({ name: startedPlayback ? 'Now playing playlist' : 'Queued playlist' })
        .setDescription(
          `**${result.playlistName}** — ${String(result.tracks.length)} tracks` +
            (insertNext ? ' (up next)' : ''),
        );
    } else {
      embed
        .setAuthor({ name: startedPlayback ? 'Now playing' : 'Added to queue' })
        .setDescription(`${trackLink(first)} — ${first.author}`)
        .addFields({ name: 'Duration', value: formatTrackDuration(first), inline: true });
      if (!startedPlayback) {
        embed.addFields({
          name: 'Position',
          value: insertNext ? 'Up next' : `#${String(player.queue.upcoming.length)}`,
          inline: true,
        });
      }
      if (first.artworkUrl !== null) embed.setThumbnail(first.artworkUrl);
    }

    await interaction.editReply({ embeds: [embed] });
  },
});

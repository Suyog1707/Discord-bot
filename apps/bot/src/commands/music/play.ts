/** `/play` — resolve a URL or search query and queue the result. */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LoadType } from 'shoukaku';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic, requireVoiceContext } from '../../music/voice-context.js';

/** Discord caps choice names and values at 100 characters. */
function clip(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track or playlist, or add it to the queue.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A URL (YouTube, Spotify, SoundCloud, Deezer) or a search term')
        .setRequired(true)
        .setAutocomplete(true)
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

  /**
   * Search-as-you-type suggestions. URLs pass through untouched (suggesting
   * against them is noise), short inputs wait for more letters, and any
   * Lavalink hiccup degrades to "no suggestions" — the command still accepts
   * free text, so autocomplete failing costs nothing.
   */
  async autocomplete({ interaction }) {
    const client = interaction.client as BotClient;
    const query = interaction.options.getFocused().trim();

    if (query.length < 3 || /^https?:\/\//iu.test(query)) {
      await interaction.respond([]);
      return;
    }

    const node = client.music?.shoukaku.getIdealNode();
    if (node === undefined) {
      await interaction.respond([]);
      return;
    }

    const response = await node.rest.resolve(`ytsearch:${query}`);
    if (response?.loadType !== LoadType.SEARCH) {
      await interaction.respond([]);
      return;
    }

    const suggestions = response.data.flatMap((track) => {
      const uri = track.info.uri;
      if (uri == null || uri.length > 100) return [];
      return [
        {
          name: clip(`${track.info.title} — ${track.info.author}`),
          // The URI as the value makes the eventual /play resolve exact.
          value: uri,
        },
      ];
    });
    await interaction.respond(suggestions.slice(0, 10));
  },

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

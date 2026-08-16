/** `/play` — resolve a URL or search query and queue the result. */
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { LoadType } from 'shoukaku';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import type { ResolveResult } from '../../music/music-manager.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic, requireVoiceContext } from '../../music/voice-context.js';

/** Discord caps choice names and values at 100 characters. */
function clip(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Suggestion cache.
 *
 * Autocomplete fires on every keystroke, so a typed query hits Lavalink once
 * per character — searches that compete with real playback resolution for the
 * same node. Prefixes of the same phrase repeat constantly while typing, so a
 * short-lived cache removes most of that traffic.
 */
const SUGGESTION_TTL_MS = 60_000;
const SUGGESTION_MAX_ENTRIES = 500;
const suggestionCache = new Map<
  string,
  { choices: { name: string; value: string }[]; expiresAt: number }
>();

function cachedSuggestions(query: string): { name: string; value: string }[] | null {
  const hit = suggestionCache.get(query);
  if (hit === undefined) return null;
  if (hit.expiresAt <= Date.now()) {
    suggestionCache.delete(query);
    return null;
  }
  return hit.choices;
}

function cacheSuggestions(query: string, choices: { name: string; value: string }[]): void {
  if (suggestionCache.size >= SUGGESTION_MAX_ENTRIES) {
    const oldest = suggestionCache.keys().next();
    if (!(oldest.done ?? false)) suggestionCache.delete(oldest.value);
  }
  suggestionCache.set(query, { choices, expiresAt: Date.now() + SUGGESTION_TTL_MS });
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
  // Acknowledged by the dispatcher before guards run: the cooldown (Redis) and
  // DJ (Postgres) checks are remote, and deferring after them is what let the
  // three-second window lapse and invalidate the interaction.
  deferral: 'public',

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

    const cached = cachedSuggestions(query);
    if (cached !== null) {
      await interaction.respond(cached);
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

    const suggestions = response.data
      .flatMap((track) => {
        const uri = track.info.uri;
        if (uri == null || uri.length > 100) return [];
        return [
          {
            name: clip(`${track.info.title} — ${track.info.author}`),
            // The URI as the value makes the eventual /play resolve exact.
            value: uri,
          },
        ];
      })
      .slice(0, 10);
    cacheSuggestions(query, suggestions);
    await interaction.respond(suggestions);
  },

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const context = requireVoiceContext(interaction);

    // Already acknowledged by the dispatcher (`deferral: 'public'`), so every
    // response below is an editReply/followUp.

    const query = interaction.options.getString('query', true);
    const source = (interaction.options.getString('source') ?? 'youtube') as
      'youtube' | 'soundcloud';
    const insertNext = interaction.options.getBoolean('next') ?? false;

    // Whether the bot was already in voice decides how a failed lookup is
    // cleaned up below — check before the join can create a player.
    const alreadyConnected = music.getPlayer(context.guildId) !== undefined;

    // Track lookup and joining voice are independent — the gateway round-trip
    // for the voice connection is dead time if it waits for the search.
    const resolving = music.resolve(
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
    const joining = music.getOrCreatePlayer({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });
    // Awaited below; this only stops a join failure from surfacing as an
    // unhandled rejection while the lookup is still running.
    joining.catch(() => undefined);

    let result: ResolveResult;
    try {
      result = await resolving;
    } catch (error) {
      // The join was racing the lookup, so a query that resolved to nothing
      // must not leave the bot parked in a channel it entered for this command.
      if (!alreadyConnected) {
        void joining
          .then(async (joined) => {
            if (!joined.isPlaying && joined.queue.tracks.length === 0) {
              await music.destroyPlayer(context.guildId);
            }
          })
          .catch(() => undefined);
      }
      throw error;
    }

    const player = await joining;

    const { startedPlayback } = await player.enqueue(result.tracks, { next: insertNext });

    if (result.background !== undefined) {
      // Each resolved batch is queued as it lands, so the queue keeps growing
      // while the first tracks play instead of arriving all at the end.
      void result.background
        .run(async (tracks) => {
          await player.enqueue(tracks);
        })
        .then(async (completed) => {
          const queued = result.tracks.length + completed.resolvedTrackCount;
          const failed = completed.failedTrackCount;
          await interaction.followUp({
            content:
              `Spotify playlist loading complete: queued ${String(queued)} of ` +
              `${String(result.tracks.length + completed.sourceTrackCount)} tracks.` +
              (failed === 0 ? '' : ` ${String(failed)} could not be resolved.`),
            flags: MessageFlags.Ephemeral,
          });
        })
        .catch((error: unknown) => {
          client.logger.warn({ err: error }, 'Background Spotify playlist expansion failed');
        });
    }

    const [first] = result.tracks;
    if (first === undefined) return; // resolve() already threw on empty results

    const embed = new EmbedBuilder().setColor(0x5865f2);

    if (result.playlistName !== null) {
      embed
        .setAuthor({ name: startedPlayback ? 'Now playing playlist' : 'Queued playlist' })
        .setDescription(
          `**${result.playlistName}** — ` +
            (result.background === undefined
              ? `${String(result.tracks.length)} track(s)`
              : 'starting now, the rest is being queued…') +
            (insertNext ? ' (up next)' : ''),
        );

      // Without this the playlist just arrives short and looks like tracks were
      // dropped. Spotify hands an unauthorised client one 100-track page and
      // ignores every request for the next one, so the shortfall is not
      // something the bot can page around — only the user's own Spotify
      // authorisation lifts it.
      if (result.truncated === true) {
        embed.addFields({
          name: 'Only part of this playlist',
          value:
            'Spotify only shares the first 100 tracks of a playlist with apps that ' +
            'are not connected to your account. Run `/spotify connect` and queue it ' +
            'again to get the whole thing.',
        });
      }
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

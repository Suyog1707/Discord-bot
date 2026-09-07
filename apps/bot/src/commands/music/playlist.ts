/**
 * `/playlist` — full playlist management from Discord: create, curate, play,
 * share with the server, move between platforms (export/import) and organise
 * (folders, favorites, search). Mirrors the dashboard feature set; both sit
 * on the same rows, so edits made in one place appear in the other.
 */
import {
  LIMITS,
  NotFoundError,
  playlistExportSchema,
  ValidationError,
} from '@discord-music/shared';
import type { Playlist } from '@discord-music/database';
import { AttachmentBuilder, EmbedBuilder, type SlashCommandStringOption } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import type { PlaylistRef } from '../../services/playlists-service.js';
import type { QueuedTrack } from '../../music/track.js';
import { formatTrackDuration } from '../../music/track.js';
import {
  requireActivePlayer,
  requireMusic,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

/** Max tracks that need a live re-resolve (no encoded blob) per play. */
const RESOLVE_BUDGET = 100;
/** Import attachments larger than this are rejected before download. */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const EMBED_COLOR = 0x5865f2;

function refFrom(interaction: {
  user: { id: string; username: string };
  guildId: string | null;
}): PlaylistRef {
  return {
    discordId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
  };
}

function describe(playlist: Playlist): string {
  const bits = [
    `${String(playlist.trackCount)} track(s)`,
    playlist.favorite ? '⭐ favorite' : null,
    playlist.folder === null ? null : `📁 ${playlist.folder}`,
    playlist.guildId === null ? null : '🌐 shared',
    playlist.spotifyId === null ? null : '🎧 Spotify',
  ].filter((bit) => bit !== null);
  return bits.join(' · ');
}

const nameOption = (description: string) => (option: SlashCommandStringOption) =>
  option
    .setName('name')
    .setDescription(description)
    .setMaxLength(LIMITS.PLAYLIST_NAME_MAX_LENGTH)
    .setRequired(true)
    .setAutocomplete(true);

/** Subcommands whose result is for the whole channel, not just the caller. */
const PUBLIC_SUBCOMMANDS = new Set(['play', 'shuffle']);

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Create, manage and play your playlists.')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create an empty playlist.')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Playlist name')
            .setMaxLength(LIMITS.PLAYLIST_NAME_MAX_LENGTH)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('folder')
            .setDescription('Optional folder to file it under')
            .setMaxLength(LIMITS.PLAYLIST_NAME_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete one of your playlists.')
        .addStringOption(nameOption('Playlist to delete')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('Rename one of your playlists.')
        .addStringOption(nameOption('Playlist to rename'))
        .addStringOption((option) =>
          option
            .setName('new_name')
            .setDescription('The new name')
            .setMaxLength(LIMITS.PLAYLIST_NAME_MAX_LENGTH)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Your playlists, plus ones shared with this server.'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Details and first tracks of a playlist.')
        .addStringOption(nameOption('Playlist to inspect')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add the current track (or a search) to a playlist.')
        .addStringOption(nameOption('Playlist to add to'))
        .addStringOption((option) =>
          option.setName('query').setDescription('Search or URL — omit to add the playing track'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a track from a playlist by its number.')
        .addStringOption(nameOption('Playlist to edit'))
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Track number from /playlist info')
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Queue a playlist in your voice channel.')
        .addStringOption(nameOption('Playlist to play')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('shuffle')
        .setDescription('Queue a playlist in random order.')
        .addStringOption(nameOption('Playlist to shuffle')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('duplicate')
        .setDescription('Copy a playlist into your own collection.')
        .addStringOption(nameOption('Playlist to copy')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('Download a playlist as a portable JSON file.')
        .addStringOption(nameOption('Playlist to export')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('import')
        .setDescription('Import a playlist from an exported JSON file.')
        .addAttachmentOption((option) =>
          option.setName('file').setDescription('A playlist export (.json)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('share')
        .setDescription('Share a playlist with this server (run again to unshare).')
        .addStringOption(nameOption('Playlist to share')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('favorite')
        .setDescription('Star a playlist so it sorts first (run again to unstar).')
        .addStringOption(nameOption('Playlist to star')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Find playlists by name.')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('Part of the playlist name')
            .setMaxLength(LIMITS.PLAYLIST_NAME_MAX_LENGTH)
            .setRequired(true),
        ),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  // `play` and `shuffle` fill the channel's queue and belong in the channel;
  // every other subcommand manages the caller's own library.
  deferral: (interaction) =>
    PUBLIC_SUBCOMMANDS.has(interaction.options.getSubcommand()) ? 'public' : 'ephemeral',

  async autocomplete({ interaction }) {
    const client = interaction.client as BotClient;
    const focused = interaction.options.getFocused().trim();
    const names = await client.services.playlists.names(refFrom(interaction), focused);
    await interaction.respond(names.map((name) => ({ name, value: name })));
  },

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const playlists = client.services.playlists;
    const subcommand = interaction.options.getSubcommand(true);
    const ref = refFrom(interaction);

    switch (subcommand) {
      case 'create': {
        const name = interaction.options.getString('name', true).trim();
        const folder = interaction.options.getString('folder')?.trim() ?? null;
        const playlist = await playlists.create(ref, name, folder === '' ? null : folder);
        await interaction.editReply({
          content: `🎶 Created **${playlist.name}** — add tracks with \`/playlist add\`.`,
        });
        return;
      }

      case 'delete': {
        const name = await playlists.delete(ref, interaction.options.getString('name', true));
        await interaction.editReply({ content: `🗑️ Deleted **${name}**.` });
        return;
      }

      case 'rename': {
        const updated = await playlists.rename(
          ref,
          interaction.options.getString('name', true),
          interaction.options.getString('new_name', true).trim(),
        );
        await interaction.editReply({ content: `✏️ Renamed to **${updated.name}**.` });
        return;
      }

      case 'list': {
        const { own, shared } = await playlists.list(ref);
        if (own.length === 0 && shared.length === 0) {
          throw new NotFoundError('No playlists yet — start one with `/playlist create`.');
        }
        const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Playlists');
        if (own.length > 0) {
          embed.addFields({
            name: `Yours (${String(own.length)})`,
            value: own
              .slice(0, 15)
              .map((playlist) => `**${playlist.name}** — ${describe(playlist)}`)
              .join('\n'),
          });
        }
        if (shared.length > 0) {
          embed.addFields({
            name: 'Shared with this server',
            value: shared
              .slice(0, 10)
              .map((playlist) => `**${playlist.name}** — ${describe(playlist)}`)
              .join('\n'),
          });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      case 'info': {
        const playlist = await playlists.resolve(ref, interaction.options.getString('name', true));
        const tracks = await playlists.tracks(playlist.id, 10);
        const totalMs = tracks.reduce((sum, track) => sum + track.durationMs, 0);
        const lines = tracks.map(
          (track, index) =>
            `\`${String(index + 1).padStart(2, ' ')}.\` ${track.title} — ${track.author} \`${formatTrackDuration(
              { durationMs: track.durationMs, isStream: false },
            )}\``,
        );
        const embed = new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle(playlist.name)
          .setDescription(lines.join('\n') || '*Empty — add tracks with `/playlist add`.*')
          .setFooter({
            text: [
              describe(playlist),
              `played ${String(playlist.playCount)}×`,
              playlist.trackCount > tracks.length
                ? `showing ${String(tracks.length)} of ${String(playlist.trackCount)}`
                : null,
              totalMs > 0 ? formatTrackDuration({ durationMs: totalMs, isStream: false }) : null,
            ]
              .filter((bit) => bit !== null)
              .join(' · '),
          });
        if (playlist.description !== null)
          embed.addFields({ name: 'About', value: playlist.description });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      case 'add': {
        const name = interaction.options.getString('name', true);
        const query = interaction.options.getString('query')?.trim();

        let track: QueuedTrack;
        if (query === undefined || query === '') {
          const player = requireActivePlayer(
            requireRouter(client),
            requireVoiceContext(interaction),
          );
          const current = player.queue.current;
          if (current === null) {
            throw new NotFoundError('Nothing is playing — pass a `query` to search instead.');
          }
          track = current;
        } else {
          const music = requireMusic(client);
          const result = await music.resolve(query, {
            id: interaction.user.id,
            name: interaction.user.username,
          });
          const [first] = result.tracks;
          if (first === undefined) throw new NotFoundError(`Nothing found for **${query}**.`);
          track = first;
        }

        const playlist = await playlists.addTrack(ref, name, track);
        await interaction.editReply(
          `➕ Added **${track.title}** to **${playlist.name}** (${String(playlist.trackCount)} tracks).`,
        );
        return;
      }

      case 'remove': {
        const { playlist, removed } = await playlists.removeTrack(
          ref,
          interaction.options.getString('name', true),
          interaction.options.getInteger('number', true),
        );
        await interaction.editReply({
          content: `➖ Removed **${removed.title}** from **${playlist.name}**.`,
        });
        return;
      }

      case 'play':
      case 'shuffle': {
        const music = requireMusic(client);
        const router = requireRouter(client);
        const context = requireVoiceContext(interaction);
        const playlist = await playlists.resolve(ref, interaction.options.getString('name', true));
        const stored = await playlists.tracks(playlist.id);
        if (stored.length === 0) {
          throw new NotFoundError(`**${playlist.name}** is empty.`);
        }

        const player = await router.joinRoom({
          guildId: context.guildId,
          voiceChannelId: context.voiceChannelId,
          textChannelId: interaction.channelId,
          shardId: interaction.guild?.shardId ?? 0,
        });

        const ordered =
          subcommand === 'shuffle' ? [...stored].sort(() => Math.random() - 0.5) : stored;
        const requester = { id: interaction.user.id, name: interaction.user.username };

        // Tracks saved by the bot carry a Lavalink blob and enqueue directly;
        // imports (dashboard JSON, Spotify mirrors) re-resolve by URI/search,
        // bounded so a 500-track Spotify import cannot stall the interaction.
        // The list is built first so the searches run in parallel batches
        // rather than one blocking round-trip per track.
        const capacity = Math.max(0, LIMITS.QUEUE_MAX_TRACKS - player.queue.size);
        let resolves = 0;
        const planned = ordered.slice(0, capacity).flatMap<string | QueuedTrack>((track) => {
          if (track.encoded !== '') {
            return [
              {
                encoded: track.encoded,
                identifier: track.identifier,
                title: track.title,
                author: track.author,
                durationMs: track.durationMs,
                uri: track.uri,
                artworkUrl: track.artworkUrl,
                isStream: false,
                source: track.source.toLowerCase() as QueuedTrack['source'],
                requestedById: requester.id,
                requestedByName: requester.name,
              },
            ];
          }
          if (resolves >= RESOLVE_BUDGET) return [];
          resolves += 1;
          return [track.uri ?? `${track.title} ${track.author}`];
        });

        const queued = await music.resolveEach(planned, requester, async (tracks) => {
          await player.enqueue(tracks);
        });

        if (queued === 0) {
          throw new NotFoundError(`Nothing in **${playlist.name}** could be queued right now.`);
        }
        await playlists.recordPlay(playlist.id);
        await interaction.editReply(
          `${subcommand === 'shuffle' ? '🔀' : '🎶'} Queued **${String(queued)}** of ${String(stored.length)} track(s) from **${playlist.name}**.`,
        );
        return;
      }

      case 'duplicate': {
        const copy = await playlists.duplicate(ref, interaction.options.getString('name', true));
        await interaction.editReply({
          content: `📄 Copied to **${copy.name}** (${String(copy.trackCount)} tracks).`,
        });
        return;
      }

      case 'export': {
        const doc = await playlists.export(ref, interaction.options.getString('name', true));
        const file = new AttachmentBuilder(Buffer.from(JSON.stringify(doc, null, 2), 'utf8'), {
          name: `${doc.name.replaceAll(/[^\w\- ]/gu, '_')}.json`,
        });
        await interaction.editReply({
          content: `📦 **${doc.name}** — ${String(doc.tracks.length)} track(s). Import it anywhere with \`/playlist import\`.`,
          files: [file],
        });
        return;
      }

      case 'import': {
        const attachment = interaction.options.getAttachment('file', true);
        if (attachment.size > IMPORT_MAX_BYTES) {
          throw new ValidationError('That file is too large (5 MB max).');
        }

        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new ValidationError('Could not download that attachment.');
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          throw new ValidationError('That file is not valid JSON.');
        }
        const doc = playlistExportSchema.safeParse(parsed);
        if (!doc.success) {
          throw new ValidationError(
            'That file is not a playlist export (`discord-music-playlist/v1`).',
          );
        }

        const created = await playlists.import(ref, doc.data);
        await interaction.editReply(
          `📥 Imported **${created.name}** with ${String(created.trackCount)} track(s).`,
        );
        return;
      }

      case 'share': {
        const shared = await playlists.toggleShare(
          ref,
          interaction.options.getString('name', true),
          interaction.guild?.name ?? 'this server',
        );
        await interaction.editReply({
          content: shared
            ? '🌐 Shared with this server — anyone here can `/playlist play` it now.'
            : '🔒 No longer shared with this server.',
        });
        return;
      }

      case 'favorite': {
        const starred = await playlists.toggleFavorite(
          ref,
          interaction.options.getString('name', true),
        );
        await interaction.editReply({
          content: starred ? '⭐ Starred — it now sorts first.' : 'Removed the star.',
        });
        return;
      }

      default: {
        // search
        const query = interaction.options.getString('query', true).trim();
        const results = await playlists.search(ref, query);
        if (results.length === 0) {
          throw new NotFoundError(`No playlists matching **${query}**.`);
        }
        const embed = new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle(`Playlists matching “${query}”`)
          .setDescription(
            results.map((playlist) => `**${playlist.name}** — ${describe(playlist)}`).join('\n'),
          );
        await interaction.editReply({ embeds: [embed] });
      }
    }
  },
});

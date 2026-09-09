/**
 * `/spotify` — account linking status and the linked user's playlists,
 * browsable in Discord with play/queue/import actions.
 *
 * OAuth itself happens on the dashboard (a bot cannot host a browser
 * redirect), so `connect` hands out the settings link. Playback never
 * streams from Spotify: tracks resolve through Lavalink search from
 * metadata, the same path as Spotify URLs in `/play`.
 */
import {
  baseCustomId,
  NotFoundError,
  toAppError,
  UpstreamError,
  withComponentOwner,
} from '@discord-music/shared';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
} from 'discord.js';

import { getEnv } from '../../config/env.js';
import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import type { UserPlaylist } from '../../services/spotify-service.js';
import { queuedKeys, withoutQueued } from '../../music/queue-dedupe.js';
import { requireMusic, requireRouter, requireVoiceContext } from '../../music/voice-context.js';

const EMBED_COLOR = 0x1db954; // Spotify green
const PAGE_SIZE = 10;
/** Above this many tracks, warn that matching will take a while before it does. */
const PROGRESS_NOTICE_THRESHOLD = 50;
/** How long the browser stays interactive. */
const BROWSE_TTL_MS = 5 * 60_000;

function dashboardSettingsUrl(): string | null {
  const base = getEnv().DASHBOARD_URL;
  return base === undefined ? null : `${base.replace(/\/$/u, '')}/dashboard/settings`;
}

function clip(text: string, max = 100): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function pageView(items: readonly UserPlaylist[], page: number, botId: string) {
  const totalPages = Math.max(Math.ceil(items.length / PAGE_SIZE), 1);
  const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Your Spotify playlists')
    .setDescription(
      slice
        .map((item, index) => {
          const number = page * PAGE_SIZE + index + 1;
          const owner = item.owner === null ? '' : ` · by ${item.owner}`;
          const count =
            item.spotifyId === 'liked-songs' ? '' : ` · ${String(item.trackCount)} tracks`;
          return `**${String(number)}.** ${item.name}${count}${owner}`;
        })
        .join('\n'),
    )
    .setFooter({
      text: `Page ${String(page + 1)}/${String(totalPages)} · pick one below for actions`,
    });

  const select = new StringSelectMenuBuilder()
    .setCustomId(withComponentOwner('spl:select', botId))
    .setPlaceholder('Choose a playlist…')
    .addOptions(
      slice.map((item) => ({
        label: clip(item.name),
        description: clip(
          [item.owner === null ? null : `by ${item.owner}`, `${String(item.trackCount)} tracks`]
            .filter((bit) => bit !== null)
            .join(' · '),
        ),
        value: item.spotifyId,
      })),
    );

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select),
  ];
  if (totalPages > 1) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(withComponentOwner('spl:prev', botId))
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(withComponentOwner('spl:next', botId))
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

function detailView(item: UserPlaylist, botId: string) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(item.name)
    .addFields(
      { name: 'Tracks', value: String(item.trackCount) || '—', inline: true },
      { name: 'Owner', value: item.owner ?? 'You', inline: true },
      {
        name: 'Visibility',
        value: item.isPublic === null ? 'Unknown' : item.isPublic ? 'Public' : 'Private',
        inline: true,
      },
    )
    .setFooter({ text: 'Play and queue resolve through your music sources, never Spotify audio.' });
  if (item.artworkUrl !== null) embed.setThumbnail(item.artworkUrl);

  const actions = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(withComponentOwner('spl:play', botId))
      .setLabel('Play now')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(withComponentOwner('spl:queue', botId))
      .setLabel('Add to queue')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(withComponentOwner('spl:import', botId))
      .setLabel('Import')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(withComponentOwner('spl:sync', botId))
      .setLabel('Sync')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(withComponentOwner('spl:back', botId))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [actions] };
}

async function browsePlaylists(
  interaction: ChatInputCommandInteraction,
  client: BotClient,
  query: string | null,
): Promise<void> {
  const spotify = client.services.spotify;

  if (!spotify.isConfigured()) {
    throw new UpstreamError('Spotify is not configured on this bot.');
  }
  if (!spotify.canReadTokens()) {
    const url = dashboardSettingsUrl();
    throw new UpstreamError(
      url === null
        ? 'Spotify playlists are only available on the dashboard right now.'
        : `Spotify playlists are only available on the dashboard right now: ${url}`,
    );
  }

  const all = await spotify.listPlaylists(interaction.user.id);
  const items =
    query === null
      ? all
      : all.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  if (items.length === 0) {
    throw new NotFoundError(
      query === null
        ? 'No playlists on your Spotify account.'
        : `No playlists matching **${query}**.`,
    );
  }

  /**
   * Which bot is running this.
   *
   * The collector below holds the paging state in a closure, so every click
   * has to come back to this process. Command replies all go out under the
   * command application's name, so the message cannot say which bot that is —
   * the buttons carry it instead.
   */
  const botId = client.identity.label;

  let page = 0;
  let selected: UserPlaylist | null = null;
  const message = await interaction.editReply(pageView(items, page, botId));

  const collector = message.createMessageComponentCollector({ time: BROWSE_TTL_MS });

  collector.on('collect', (component) => {
    void (async () => {
      try {
        if (component.isStringSelectMenu() && baseCustomId(component.customId) === 'spl:select') {
          const [value] = component.values;
          selected = items.find((item) => item.spotifyId === value) ?? null;
          if (selected === null) return;
          await component.update(detailView(selected, botId));
          return;
        }
        if (!component.isButton()) return;

        switch (baseCustomId(component.customId)) {
          case 'spl:prev':
          case 'spl:next': {
            page += component.customId === 'spl:next' ? 1 : -1;
            page = Math.max(0, Math.min(page, Math.ceil(items.length / PAGE_SIZE) - 1));
            await component.update(pageView(items, page, botId));
            return;
          }
          case 'spl:back':
            selected = null;
            await component.update(pageView(items, page, botId));
            return;
          case 'spl:import':
          case 'spl:sync': {
            if (selected === null) return;
            await component.deferUpdate();
            const result = await spotify.importItem(interaction.user.id, selected);
            await component.followUp({
              content: result.changed
                ? `📥 ${component.customId === 'spl:sync' ? 'Synced' : 'Imported'} **${result.name}** — ${String(result.trackCount)} track(s). Play it with \`/playlist play\`.`
                : `**${result.name}** is already up to date.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          case 'spl:play':
          case 'spl:queue': {
            if (selected === null) return;
            const music = requireMusic(client);
            const context = requireVoiceContext(interaction);
            await component.deferUpdate();

            // The whole playlist, bounded only by SPOTIFY_PLAYLIST_MAX_TRACKS —
            // which is itself capped at the queue's capacity. This used to be a
            // hardcoded 25, which silently truncated every playlist longer than
            // that while the configured limit sat unread.
            const tracks = await spotify.playlistTracks(
              interaction.user.id,
              selected.spotifyId,
              getEnv().SPOTIFY_PLAYLIST_MAX_TRACKS,
            );
            const player = await requireRouter(client).joinRoom({
              guildId: context.guildId,
              voiceChannelId: context.voiceChannelId,
              textChannelId: interaction.channelId,
              shardId: interaction.guild?.shardId ?? 0,
            });

            // Anything already queued is dropped before resolution rather than
            // after: a duplicate that reaches the matcher has cost a Lavalink
            // search to produce a track that gets thrown away.
            const { keep: fresh, skipped: duplicates } = withoutQueued(
              tracks,
              queuedKeys(player.queue.tracks),
            );

            const room = player.queue.capacity - player.queue.size;
            const queueable = fresh.slice(0, Math.max(room, 0));
            // Stopping here beats letting `add` throw partway through: the
            // batch is appended incrementally, so a QueueFullError mid-flight
            // would leave an arbitrary prefix queued and report a failure.
            const overflow = fresh.length - queueable.length;

            // One Lavalink search per track, a few at a time, so a long
            // playlist takes minutes of wall clock. Playback starts on the
            // first resolved batch, but the reply below does not land until the
            // last one — say so up front rather than leaving a big queue
            // looking like a hung command.
            if (queueable.length > PROGRESS_NOTICE_THRESHOLD) {
              await component
                .followUp({
                  content: `🔎 Matching **${String(queueable.length)}** track(s) from **${selected.name}** — playback starts as soon as the first few are ready.`,
                  flags: MessageFlags.Ephemeral,
                })
                .catch(() => undefined);
            }

            const requester = { id: interaction.user.id, name: interaction.user.username };
            const playNow = component.customId === 'spl:play';
            // Searches run in parallel batches; each finished batch is appended
            // in original order, so playback starts on the first few tracks
            // instead of after every one has been looked up.
            // Metadata straight into the Spotify matching pipeline: every
            // queued track keeps its Spotify identity (title, artist, URL)
            // instead of degrading into a plain provider search result.
            const { resolvedTrackCount: queued } = await music.resolveSpotifyMetadata(
              queueable,
              requester,
              async (resolved) => {
                await player.enqueue(resolved, playNow ? { next: false } : {});
              },
            );
            if (queued > 0 && playNow && player.queue.upcoming.length >= queued) {
              // The batch was appended; jump playback to its first track.
              const offset = player.queue.upcoming.length - queued + 1;
              await player.jumpTo(player.queue.currentIndex + offset);
            }
            // Every track that did not make it is accounted for by name.
            // "Queued 12" against a 300-track playlist is alarming without the
            // reason, and each of these has a different remedy.
            const notes: string[] = [];
            if (duplicates > 0) notes.push(`${String(duplicates)} already in the queue`);
            if (overflow > 0) notes.push(`${String(overflow)} over the queue limit`);
            const unmatched = queueable.length - queued;
            if (unmatched > 0) notes.push(`${String(unmatched)} could not be matched`);
            const suffix = notes.length > 0 ? ` (skipped ${notes.join(', ')})` : '';

            await component.followUp({
              content:
                queued === 0
                  ? duplicates > 0 && fresh.length === 0
                    ? `Every track in **${selected.name}** is already queued.`
                    : `None of those tracks could be matched right now.${suffix}`
                  : `${playNow ? '▶️ Playing' : '➕ Queued'} **${String(queued)}** track(s) from **${selected.name}**${suffix}.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          default:
        }
      } catch (error) {
        const appError = toAppError(error);
        await component
          .followUp({
            content: appError.expected ? appError.message : 'That action failed. Try again.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined);
      }
    })();
  });

  collector.on('end', () => {
    void interaction.editReply({ components: [] }).catch(() => undefined);
  });
}

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Link Spotify and browse your playlists.')
    .addSubcommand((sub) =>
      sub.setName('connect').setDescription('Link your Spotify account (via the dashboard).'),
    )
    .addSubcommand((sub) =>
      sub.setName('disconnect').setDescription('Unlink your Spotify account.'),
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Your Spotify link status.'))
    .addSubcommand((sub) =>
      sub
        .setName('playlists')
        .setDescription('Browse your Spotify playlists: play, queue or import them.')
        .addStringOption((option) =>
          option.setName('query').setDescription('Filter playlists by name').setMaxLength(100),
        ),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const spotify = client.services.spotify;
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === 'connect') {
      const account = await spotify.status(interaction.user.id);
      if (account !== null) {
        await interaction.editReply({
          content: `Already linked as **${account.displayName ?? account.spotifyId}** — \`/spotify playlists\` is ready.`,
        });
        return;
      }
      const url = dashboardSettingsUrl();
      const row =
        url === null
          ? []
          : [
              new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
                new ButtonBuilder()
                  .setLabel('Connect Spotify')
                  .setStyle(ButtonStyle.Link)
                  .setURL(url),
              ),
            ];
      await interaction.editReply({
        content:
          'Linking happens on the dashboard (Spotify needs a browser sign-in): open **Settings → Spotify** and press Connect. Your playlists then work here too.',
        components: row,
      });
      return;
    }

    if (subcommand === 'disconnect') {
      const removed = await spotify.disconnect(interaction.user.id);
      if (!removed) throw new NotFoundError('No Spotify account is linked.');
      await interaction.editReply({ content: '🔌 Spotify unlinked.' });
      return;
    }

    if (subcommand === 'status') {
      const account = await spotify.status(interaction.user.id);
      if (account === null) {
        await interaction.editReply({
          content: 'Not linked. Run `/spotify connect` to get started.',
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Spotify — linked')
        .addFields(
          { name: 'Account', value: account.displayName ?? account.spotifyId, inline: true },
          { name: 'Country', value: account.country ?? '—', inline: true },
          {
            name: 'Linked',
            value: `<t:${String(Math.floor(account.createdAt.getTime() / 1000))}:R>`,
            inline: true,
          },
          {
            name: 'Scopes',
            value: account.scopes
              .split(' ')
              .map((s) => `\`${s}\``)
              .join(' '),
          },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // playlists
    await browsePlaylists(interaction, client, interaction.options.getString('query'));
  },
});

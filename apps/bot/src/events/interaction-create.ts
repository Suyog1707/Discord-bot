/**
 * Central interaction dispatcher.
 *
 * All slash-command error handling lives here so individual commands can throw
 * freely and stay focused on their own logic. Covers routing, guard
 * enforcement (guild-only, permissions, cooldowns, DJ role), unknown-command
 * handling and safe error replies.
 */
import { LIMITS } from '@discord-music/shared';
import { EmbedBuilder, Events, GuildMember, MessageFlags } from 'discord.js';

import { dispatchChatInputCommand } from '../core/dispatch-command.js';
import { defineEvent } from '../core/event.js';
import { replyWithError } from '../core/interaction-response.js';
import { FILTER_PRESETS, speedFilter, type FilterPresetName } from '../music/filters.js';
import { fetchLyrics } from '../music/lyrics.js';
import {
  MUSIC_BUTTON_PREFIX,
  MUSIC_FILTER_SELECT_ID,
  renderNowPlaying,
  type MusicButtonAction,
} from '../music/now-playing-view.js';
import { formatTrackDuration, trackLink } from '../music/track.js';

export default defineEvent({
  name: Events.InteractionCreate,
  async execute({ client, logger }, interaction) {
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;

      try {
        await command.autocomplete({
          interaction,
          logger: logger.child({ command: interaction.commandName }),
        });
      } catch (error) {
        // Autocomplete has a 3s budget; never block, just record the failure.
        logger.error({ err: error, command: interaction.commandName }, 'Autocomplete failed');
      }
      return;
    }

    // The controller's filter/equalizer/speed menu.
    if (interaction.isStringSelectMenu() && interaction.customId === MUSIC_FILTER_SELECT_ID) {
      const selectLogger = logger.child({
        select: interaction.customId,
        guildId: interaction.guildId ?? undefined,
        userId: interaction.user.id,
      });
      try {
        const player =
          interaction.guildId === null ? undefined : client.music?.getPlayer(interaction.guildId);
        if (player === undefined) {
          await interaction.reply({
            content: 'Nothing is playing.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const member = interaction.member instanceof GuildMember ? interaction.member : null;
        if (member?.voice.channelId !== player.voiceChannelId) {
          await interaction.reply({
            content: 'Join my voice channel to change filters.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const [value] = interaction.values;
        if (value === 'off' || value === undefined) {
          await player.setFilter(null, {});
        } else if (value.startsWith('preset:')) {
          const name = value.slice('preset:'.length) as FilterPresetName;
          await player.setFilter(name, FILTER_PRESETS[name]);
        } else if (value.startsWith('speed:')) {
          const speed = Number(value.slice('speed:'.length));
          await player.setFilter('speed', speedFilter(speed));
        }
        // The controller re-renders itself from the FILTER_CHANGE event.
        await interaction.deferUpdate();
        selectLogger.info('Filter select applied');
      } catch (error) {
        selectLogger.error({ err: error }, 'Filter select failed');
        await replyWithError(interaction, 'Changing the filter failed. Try again.', selectLogger);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(MUSIC_BUTTON_PREFIX)) {
      const buttonLogger = logger.child({
        button: interaction.customId,
        guildId: interaction.guildId ?? undefined,
        userId: interaction.user.id,
      });

      try {
        const player =
          interaction.guildId === null ? undefined : client.music?.getPlayer(interaction.guildId);
        if (player?.queue.current == null) {
          await interaction.update({ content: 'Nothing is playing.', embeds: [], components: [] });
          return;
        }

        // Transport buttons are voice actions: the clicker must share the
        // bot's voice channel, same as the slash commands they mirror.
        const member = interaction.member instanceof GuildMember ? interaction.member : null;
        if (member?.voice.channelId !== player.voiceChannelId) {
          await interaction.reply({
            content: 'Join my voice channel to control playback.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const action = interaction.customId.slice(MUSIC_BUTTON_PREFIX.length) as MusicButtonAction;

        // Informational buttons reply ephemerally instead of touching the
        // message they live on.
        if (
          action === 'favorite' ||
          action === 'dislike' ||
          action === 'queue' ||
          action === 'lyrics'
        ) {
          // Non-null by the guard above; narrowed once for the branches below.
          const current = player.queue.current;
          if (action === 'favorite') {
            const added = await client.services.favorites.add(
              interaction.user.id,
              interaction.user.username,
              current,
            );
            await interaction.reply({
              content: added
                ? `⭐ Saved **${current.title}** to your favorites.`
                : `**${current.title}** is already in your favorites.`,
              flags: MessageFlags.Ephemeral,
            });
          } else if (action === 'dislike') {
            // "Not like" is stronger than a skip: remembered, and the song
            // is pulled from everywhere autoplay could bring it back from.
            // A write plus a skip does not fit the three-second window.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const music = client.music;
            const persisted = await client.services.dislikes.add(
              interaction.user.id,
              interaction.user.username,
              {
                title: current.title,
                author: current.author,
                ...(current.sourceKey === undefined ? {} : { trackKey: current.sourceKey }),
              },
              'button',
            );
            music?.applyDislike(player.guildId, current);
            await player.skip();
            await interaction.editReply({
              content: persisted
                ? `👎 Won't recommend **${current.title}** again — skipped.`
                : `**${current.title}** was already on your "not like" list — skipped.`,
            });
          } else if (action === 'queue') {
            const upcoming = player.queue.upcoming.slice(0, 10);
            const lines = upcoming.map(
              (track, index) =>
                `\`${String(index + 1).padStart(2, ' ')}.\` ${trackLink(track)} \`${formatTrackDuration(track)}\``,
            );
            const embed = new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle('Queue')
              .setDescription(
                [`**Now:** ${trackLink(current)}`, lines.join('\n') || '*Nothing upcoming.*'].join(
                  '\n\n',
                ),
              );
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          } else {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await fetchLyrics(current.title, current.author);
            await interaction.editReply(
              result === null
                ? `No lyrics found for **${current.title}**.`
                : {
                    embeds: [
                      new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`${current.title} — ${current.author}`)
                        .setDescription(result.lyrics)
                        .setFooter({ text: 'Lyrics from LRCLIB' }),
                    ],
                  },
            );
          }
          buttonLogger.info('Music button applied');
          return;
        }

        switch (action) {
          case 'previous':
            await player.previous();
            break;
          case 'toggle':
            await (player.paused ? player.resume() : player.pause());
            break;
          case 'skip':
            await player.skip();
            break;
          case 'stop':
            await player.stop();
            break;
          case 'shuffle':
            player.shuffle();
            break;
          case 'loop': {
            const mode = player.queue.loopMode;
            player.setLoopMode(mode === 'off' ? 'track' : mode === 'track' ? 'queue' : 'off');
            break;
          }
          case 'autoplay':
            player.setAutoplayEnabled(!player.autoplayEnabled);
            break;
          case 'voldown':
            await player.setVolume(Math.max(LIMITS.VOLUME_MIN, player.volume - 10));
            break;
          case 'volup':
            await player.setVolume(Math.min(LIMITS.VOLUME_MAX, player.volume + 10));
            break;
        }

        // The persistent controller re-renders itself from player events, so a
        // click on it only needs acknowledging. The ephemeral /nowplaying view
        // has no event feed and re-renders here instead.
        const isEphemeralView = interaction.message.flags.has(MessageFlags.Ephemeral);
        if (!isEphemeralView) {
          await interaction.deferUpdate();
        } else if (action === 'stop') {
          await interaction.update({ content: '⏹️ Stopped.', embeds: [], components: [] });
        } else {
          // A skip that drained the queue renders as "Nothing is playing".
          await interaction.update(renderNowPlaying(player));
        }
        buttonLogger.info('Music button applied');
      } catch (error) {
        buttonLogger.error({ err: error }, 'Music button failed');
        await replyWithError(interaction, 'That control failed. Try again.', buttonLogger);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Everything from here — the duplicate check, the acknowledgement, the
    // guards, the error handling — is shared with commands that arrive over
    // Redis from the router, because both have to behave identically.
    await dispatchChatInputCommand(client, interaction, logger);
  },
});

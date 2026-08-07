/**
 * Central interaction dispatcher.
 *
 * All slash-command error handling lives here so individual commands can throw
 * freely and stay focused on their own logic. Covers routing, guard
 * enforcement (guild-only, permissions, cooldowns, DJ role), unknown-command
 * handling and safe error replies.
 */
import { AppError, LIMITS, toAppError } from '@discord-music/shared';
import { EmbedBuilder, Events, GuildMember, MessageFlags, type Interaction } from 'discord.js';

import { defineEvent } from '../core/event.js';
import { runGuards } from '../core/guards.js';
import { FILTER_PRESETS, speedFilter, type FilterPresetName } from '../music/filters.js';
import { fetchLyrics } from '../music/lyrics.js';
import {
  MUSIC_BUTTON_PREFIX,
  MUSIC_FILTER_SELECT_ID,
  renderNowPlaying,
  type MusicButtonAction,
} from '../music/now-playing-view.js';
import { formatTrackDuration, trackLink } from '../music/track.js';

/**
 * Reply with an error, choosing the correct method for the interaction's state.
 *
 * Once an interaction has been replied to or deferred, `reply()` throws
 * `InteractionAlreadyReplied`; this picks `followUp`/`editReply` accordingly.
 */
async function replyWithError(
  interaction: Extract<Interaction, { replied: boolean }>,
  message: string,
): Promise<void> {
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;

  if (interaction.deferred) {
    await interaction.editReply({ content: message });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

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
        await replyWithError(interaction, 'Changing the filter failed. Try again.').catch(
          () => undefined,
        );
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
        if (action === 'favorite' || action === 'queue' || action === 'lyrics') {
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
        await replyWithError(interaction, 'That control failed. Try again.').catch(() => undefined);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      // Usually a stale registration — the command was removed but not redeployed.
      logger.warn({ command: interaction.commandName }, 'Received unknown command');
      await replyWithError(interaction, 'That command is no longer available.');
      return;
    }

    const commandLogger = logger.child({
      command: interaction.commandName,
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
    });

    const startedAt = Date.now();

    // Guards cover guild-only, permissions, cooldowns and the DJ role.
    try {
      const guard = await runGuards(client, command, interaction);
      if (!guard.allowed) {
        await replyWithError(interaction, guard.message ?? 'You cannot use that right now.');
        return;
      }
    } catch (error) {
      // A guard that *errors* (e.g. settings lookup with the DB down) must not
      // dead-end the interaction with silence.
      commandLogger.error({ err: error }, 'Guard evaluation failed');
      await replyWithError(interaction, 'Something went wrong checking permissions. Try again.');
      return;
    }

    try {
      await command.execute({ interaction, logger: commandLogger });
      commandLogger.info({ durationMs: Date.now() - startedAt }, 'Command executed');
    } catch (error) {
      const appError = toAppError(error);

      // Expected failures (bad input, not found) are warnings, not incidents.
      const level = appError.expected ? 'warn' : 'error';
      commandLogger[level]({ err: appError, durationMs: Date.now() - startedAt }, 'Command failed');

      try {
        await replyWithError(
          interaction,
          appError instanceof AppError && appError.expected
            ? appError.message
            : 'Something went wrong while running that command. Please try again.',
        );
      } catch (replyError) {
        commandLogger.error({ err: replyError }, 'Failed to send error reply');
      }
    }
  },
});

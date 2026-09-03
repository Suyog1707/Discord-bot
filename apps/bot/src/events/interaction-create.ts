/**
 * Central interaction dispatcher.
 *
 * All slash-command error handling lives here so individual commands can throw
 * freely and stay focused on their own logic. Covers routing, guard
 * enforcement (guild-only, permissions, cooldowns, DJ role), unknown-command
 * handling and safe error replies.
 */
import { isAppError, LIMITS, toAppError } from '@discord-music/shared';
import { EmbedBuilder, Events, GuildMember, MessageFlags } from 'discord.js';

import { defineEvent } from '../core/event.js';
import { runGuards } from '../core/guards.js';
import {
  acknowledge,
  claimInteraction,
  INSTANCE_ID,
  rejectGuard,
  replyWithError,
} from '../core/interaction-response.js';
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

    // Exactly one handler owns an interaction. A duplicate id means the same
    // gateway event was delivered or dispatched twice — the second attempt
    // could only ever fail with 40060/10062, so it is dropped and reported
    // instead of being allowed to race the first.
    if (!claimInteraction(interaction.id)) {
      logger.error(
        {
          interactionId: interaction.id,
          command: interaction.commandName,
          instanceId: INSTANCE_ID,
          pid: process.pid,
        },
        'Duplicate dispatch for the same interaction id — dropping. ' +
          'This means duplicate listeners or a second bot process sharing the token.',
      );
      return;
    }

    const command = client.commands.get(interaction.commandName);

    const commandLogger = logger.child({
      command: interaction.commandName,
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
      interactionId: interaction.id,
    });

    if (!command) {
      // Usually a stale registration — the command was removed but not redeployed.
      commandLogger.warn('Received unknown command');
      await replyWithError(interaction, 'That command is no longer available.', commandLogger);
      return;
    }

    const startedAt = Date.now();
    // How long the interaction had already been alive when it reached us. A
    // value close to Discord's three-second budget is the signal that the
    // acknowledgement is at risk, whatever the eventual outcome.
    const receivedAgeMs = startedAt - interaction.createdTimestamp;

    // Acknowledge first when the command asks for it: everything below this
    // point (guards included) performs remote I/O.
    if (command.deferral !== undefined) {
      const alive = await acknowledge(interaction, command.deferral, commandLogger);
      if (!alive) return;
      commandLogger.debug(
        { ackMs: Date.now() - startedAt, receivedAgeMs, deferral: command.deferral },
        'Interaction acknowledged',
      );
    }

    // Guards cover guild-only, permissions, cooldowns and the DJ role.
    const guardStartedAt = Date.now();
    try {
      const guard = await runGuards(client, command, interaction);
      if (!guard.allowed) {
        await rejectGuard(
          interaction,
          guard.message ?? 'You cannot use that right now.',
          commandLogger,
        );
        return;
      }
    } catch (error) {
      // A guard that *errors* (e.g. settings lookup with the DB down) must not
      // dead-end the interaction with silence.
      commandLogger.error({ err: error }, 'Guard evaluation failed');
      await replyWithError(
        interaction,
        'Something went wrong checking permissions. Try again.',
        commandLogger,
      );
      return;
    }
    const guardMs = Date.now() - guardStartedAt;

    try {
      await command.execute({ interaction, logger: commandLogger });
      commandLogger.info(
        { durationMs: Date.now() - startedAt, guardMs, receivedAgeMs },
        'Command executed',
      );
    } catch (error) {
      const appError = toAppError(error);

      // Expected failures (bad input, not found) are warnings, not incidents.
      const level = appError.expected ? 'warn' : 'error';
      commandLogger[level](
        {
          err: appError,
          durationMs: Date.now() - startedAt,
          guardMs,
          receivedAgeMs,
          acknowledged: interaction.deferred || interaction.replied,
        },
        'Command failed',
      );

      // replyWithError never throws: a dead interaction is logged and dropped
      // rather than retried into a second Unknown interaction.
      await replyWithError(
        interaction,
        isAppError(appError) && appError.expected
          ? appError.message
          : 'Something went wrong while running that command. Please try again.',
        commandLogger,
      );
    }
  },
});

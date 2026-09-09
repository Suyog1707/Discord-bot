/**
 * The buttons and the filter menu on the now-playing controller.
 *
 * Like `dispatch-command.ts`, this is shared between the two ways a component
 * interaction can arrive: straight off this bot's gateway, or off the Redis
 * queue after the command router forwarded one belonging to an application
 * whose interactions no longer come down a socket.
 *
 * **Acknowledge first, then work.** This used to do the opposite — set the
 * filter, skip the track, write the favourite, and only then tell Discord it
 * had heard — which put a Lavalink round trip and a database write inside the
 * three-second window. It survived because those are usually fast. Deferring
 * up front removes the race, and it is also what lets a routed component work
 * at all, since by then the router has already acknowledged on this bot's
 * behalf.
 *
 * After a deferred *update*, `editReply` edits the message the component sits
 * on and `followUp` posts a new ephemeral message beside it. That is the whole
 * vocabulary here: nothing calls `reply` or `update`.
 */
import { LIMITS } from '@discord-music/shared';
import {
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { fetchLyrics } from '../music/lyrics.js';
import { FILTER_PRESETS, speedFilter, type FilterPresetName } from '../music/filters.js';
import {
  MUSIC_BUTTON_PREFIX,
  MUSIC_FILTER_SELECT_ID,
  renderNowPlaying,
  type MusicButtonAction,
} from '../music/now-playing-view.js';
import { formatTrackDuration, trackLink } from '../music/track.js';
import type { Logger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';

/** Whether this interaction is one of the controller's own components. */
export function isMusicComponent(interaction: MessageComponentInteraction): boolean {
  if (interaction.isStringSelectMenu()) return interaction.customId === MUSIC_FILTER_SELECT_ID;
  return interaction.isButton() && interaction.customId.startsWith(MUSIC_BUTTON_PREFIX);
}

/**
 * Acknowledge without changing anything, unless somebody already has.
 *
 * A routed component arrives already deferred — the router answered Discord's
 * POST on this bot's behalf — so this is a no-op there and the only
 * acknowledgement on the gateway path.
 */
async function acknowledgeComponent(
  interaction: MessageComponentInteraction,
  logger: Logger,
): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    // A dead interaction is terminal; there is nothing left to answer on.
    logger.warn({ err: error }, 'Could not acknowledge a component interaction');
    return false;
  }
}

/**
 * Say something beside the message, never over it.
 *
 * The controller is a long-lived message other people are looking at — an
 * error must not replace it, which is exactly what `editReply` would do here.
 */
async function aside(
  interaction: MessageComponentInteraction,
  content: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.warn({ err: error }, 'Could not deliver a component reply');
  }
}

/** The clicker has to be in the room they are trying to control. */
function sharesVoiceChannel(
  interaction: MessageComponentInteraction,
  voiceChannelId: string,
): boolean {
  const member = interaction.member instanceof GuildMember ? interaction.member : null;
  return member?.voice.channelId === voiceChannelId;
}

export async function dispatchMusicComponent(
  client: BotClient,
  interaction: MessageComponentInteraction,
  logger: Logger,
): Promise<void> {
  const componentLogger = logger.child({
    component: interaction.customId,
    guildId: interaction.guildId ?? undefined,
    userId: interaction.user.id,
  });

  if (!(await acknowledgeComponent(interaction, componentLogger))) return;

  try {
    if (interaction.isStringSelectMenu()) {
      await applyFilterSelect(client, interaction, componentLogger);
      return;
    }
    if (interaction.isButton()) {
      await applyMusicButton(client, interaction, componentLogger);
    }
  } catch (error) {
    componentLogger.error({ err: error }, 'Component interaction failed');
    await aside(interaction, 'That control failed. Try again.', componentLogger);
  }
}

/** The controller's filter / equalizer / speed menu. */
async function applyFilterSelect(
  client: BotClient,
  interaction: StringSelectMenuInteraction,
  logger: Logger,
): Promise<void> {
  const player =
    interaction.guildId === null ? undefined : client.music?.getPlayer(interaction.guildId);
  if (player === undefined) {
    await aside(interaction, 'Nothing is playing.', logger);
    return;
  }
  if (!sharesVoiceChannel(interaction, player.voiceChannelId)) {
    await aside(interaction, 'Join my voice channel to change filters.', logger);
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

  // The controller re-renders itself from the FILTER_CHANGE event; the
  // acknowledgement above is all this click needed.
  logger.info('Filter select applied');
}

async function applyMusicButton(
  client: BotClient,
  interaction: ButtonInteraction,
  logger: Logger,
): Promise<void> {
  const player =
    interaction.guildId === null ? undefined : client.music?.getPlayer(interaction.guildId);
  if (player?.queue.current == null) {
    await interaction.editReply({ content: 'Nothing is playing.', embeds: [], components: [] });
    return;
  }

  // Transport buttons are voice actions: the clicker must share the bot's
  // voice channel, same as the slash commands they mirror.
  if (!sharesVoiceChannel(interaction, player.voiceChannelId)) {
    await aside(interaction, 'Join my voice channel to control playback.', logger);
    return;
  }

  const action = interaction.customId.slice(MUSIC_BUTTON_PREFIX.length) as MusicButtonAction;
  // Non-null by the guard above; narrowed once for every branch below.
  const current = player.queue.current;

  // Informational buttons speak beside the message rather than touching it.
  if (action === 'favorite') {
    const added = await client.services.favorites.add(
      interaction.user.id,
      interaction.user.username,
      current,
    );
    await aside(
      interaction,
      added
        ? `⭐ Saved **${current.title}** to your favorites.`
        : `**${current.title}** is already in your favorites.`,
      logger,
    );
    logger.info('Music button applied');
    return;
  }

  if (action === 'dislike') {
    // "Not like" is stronger than a skip: remembered, and the song is pulled
    // from everywhere autoplay could bring it back from.
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
    client.music?.applyDislike(player.guildId, current);
    await player.skip();
    await aside(
      interaction,
      persisted
        ? `👎 Won't recommend **${current.title}** again — skipped.`
        : `**${current.title}** was already on your "not like" list — skipped.`,
      logger,
    );
    logger.info('Music button applied');
    return;
  }

  if (action === 'queue') {
    const lines = player.queue.upcoming
      .slice(0, 10)
      .map(
        (track, index) =>
          `\`${String(index + 1).padStart(2, ' ')}.\` ${trackLink(track)} \`${formatTrackDuration(track)}\``,
      );
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Queue')
      .setDescription(
        [`**Now:** ${trackLink(current)}`, lines.join('\n') || '*Nothing upcoming.*'].join('\n\n'),
      );
    await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    logger.info('Music button applied');
    return;
  }

  if (action === 'lyrics') {
    const result = await fetchLyrics(current.title, current.author);
    await interaction.followUp(
      result === null
        ? { content: `No lyrics found for **${current.title}**.`, flags: MessageFlags.Ephemeral }
        : {
            embeds: [
              new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle(`${current.title} — ${current.author}`)
                .setDescription(result.lyrics)
                .setFooter({ text: 'Lyrics from LRCLIB' }),
            ],
            flags: MessageFlags.Ephemeral,
          },
    );
    logger.info('Music button applied');
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

  /**
   * The persistent controller re-renders itself from player events, so a click
   * on it needed only the acknowledgement. The ephemeral `/nowplaying` view
   * has no event feed and re-renders here instead.
   */
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.editReply(
      action === 'stop'
        ? { content: '⏹️ Stopped.', embeds: [], components: [] }
        : // A skip that drained the queue renders as "Nothing is playing".
          renderNowPlaying(player),
    );
  }
  logger.info('Music button applied');
}

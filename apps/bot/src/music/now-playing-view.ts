/**
 * The now-playing embed + transport buttons, shared by the `/nowplaying`
 * command (initial render) and the button handler (re-render after acting).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';

import type { GuildPlayer } from './guild-player.js';
import { renderPlatformLinks } from './platform-links.js';
import { formatTrackDuration, trackLink } from './track.js';

/** Button custom-id prefix routed by the interaction dispatcher. */
export const MUSIC_BUTTON_PREFIX = 'music:';
/** Custom id of the controller's filter/equalizer/speed select menu. */
export const MUSIC_FILTER_SELECT_ID = 'music:filter-select';

export type MusicButtonAction =
  | 'previous'
  | 'toggle'
  | 'skip'
  | 'stop'
  | 'shuffle'
  | 'loop'
  | 'favorite'
  | 'dislike'
  | 'queue'
  | 'lyrics'
  | 'autoplay'
  | 'voldown'
  | 'volup';

/** 12-slot progress bar: ▬▬▬🔘▬▬▬▬▬▬▬▬ */
export function renderProgressBar(positionMs: number, durationMs: number): string {
  const slots = 12;
  const ratio = durationMs > 0 ? Math.min(positionMs / durationMs, 1) : 0;
  const knob = Math.round(ratio * (slots - 1));
  return '▬'.repeat(knob) + '🔘' + '▬'.repeat(slots - 1 - knob);
}

export function renderNowPlaying(player: GuildPlayer): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const current = player.queue.current;
  if (current === null) {
    return { embeds: [new EmbedBuilder().setDescription('Nothing is playing.')], components: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: player.paused ? 'Paused' : 'Now playing' })
    .setDescription(`${trackLink(current)} — ${current.author}`)
    .addFields(
      {
        name: 'Progress',
        value: current.isStream
          ? '🔴 LIVE'
          : `${renderProgressBar(player.positionMs, current.durationMs)}\n` +
            `${formatTrackDuration({ durationMs: player.positionMs, isStream: false })} / ${formatTrackDuration(current)}`,
      },
      { name: 'Requested by', value: current.requestedByName, inline: true },
      { name: 'Volume', value: `${String(player.volume)}%`, inline: true },
      { name: 'Loop', value: player.queue.loopMode, inline: true },
    );

  // Resolved in the background on track start, so this is whatever has arrived
  // by the time the controller redraws — absent on the first paint at worst.
  const links = renderPlatformLinks(player.currentLinks);
  if (links !== null) embed.addFields({ name: 'Listen on', value: links });

  if (current.artworkUrl !== null) embed.setThumbnail(current.artworkUrl);

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}previous`)
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}toggle`)
      .setEmoji(player.paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}skip`)
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}stop`)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

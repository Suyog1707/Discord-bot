/**
 * Persistent "Now Playing" controller — one continuously edited message in
 * the guild's configured music channel (`GuildSettings.musicChannelId`).
 *
 * One message, never one-per-song: every player event re-renders the same
 * message, throttled so queue-storms collapse into a single edit and Discord
 * edit rate limits are never approached. When nothing is playing the message
 * flips to an idle card rather than being deleted, so the controls keep
 * their place in the channel.
 */
import type { PlayerEventType, PlayerSnapshot } from '@discord-music/shared';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageEditOptions,
} from 'discord.js';

import { getLogger, type Logger } from '../lib/logger.js';
import { MUSIC_BUTTON_PREFIX } from './now-playing-view.js';

/** Minimum gap between message edits; trailing edits are coalesced. */
const EDIT_THROTTLE_MS = 4_000;
/** Progress refresh cadence while a track plays with no other events. */
const PROGRESS_TICK_MS = 20_000;

function progressBar(positionMs: number, durationMs: number): string {
  const slots = 16;
  const ratio = durationMs > 0 ? Math.min(positionMs / durationMs, 1) : 0;
  const knob = Math.round(ratio * (slots - 1));
  return '▬'.repeat(knob) + '🔘' + '▬'.repeat(slots - 1 - knob);
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${String(hours)}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

function controls(paused: boolean, disabled: boolean) {
  const button = (id: string, emoji: string, style: ButtonStyle = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}${id}`)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button('previous', '⏮️'),
      button('toggle', paused ? '▶️' : '⏸️', ButtonStyle.Primary),
      button('skip', '⏭️'),
      button('shuffle', '🔀'),
      button('loop', '🔁'),
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button('favorite', '❤️'),
      button('queue', '📜'),
      button('lyrics', '🎵'),
      button('voldown', '🔉'),
      button('volup', '🔊'),
    ),
  ];
}

function render(state: PlayerSnapshot | null): MessageEditOptions {
  if (state?.current == null) {
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({ name: 'Nothing playing' })
      .setDescription('Start something with `/play` — this controller updates by itself.');
    return { embeds: [embed], components: controls(false, true) };
  }

  const track = state.current;
  const flags = [
    state.paused ? '⏸️ paused' : '▶️ playing',
    `🔊 ${String(state.volume)}%`,
    `source: ${track.source}`,
    state.loopMode === 'off' ? null : `🔁 ${state.loopMode}`,
    state.autoplayEnabled ? '📻 autoplay' : null,
    state.stayConnected ? '♾️ 24/7' : null,
    state.activeFilter === null ? null : `🎚️ ${state.activeFilter}`,
  ].filter((flag) => flag !== null);

  const embed = new EmbedBuilder()
    .setColor(state.paused ? 0x99aab5 : 0x5865f2)
    .setAuthor({ name: state.paused ? 'Paused' : 'Now playing' })
    .setDescription(
      track.uri === null ? `**${track.title}**` : `**[${track.title}](${track.uri})**`,
    )
    .addFields(
      { name: 'Artist', value: track.author, inline: true },
      { name: 'Requested by', value: track.requestedByName, inline: true },
      {
        name: 'Queue',
        value: `${String(state.upcomingTotal)} upcoming`,
        inline: true,
      },
      {
        name: 'Progress',
        value: track.isStream
          ? '🔴 LIVE'
          : `${progressBar(state.positionMs, track.durationMs)}\n${formatMs(state.positionMs)} / ${formatMs(track.durationMs)}`,
      },
    )
    .setFooter({ text: flags.join(' · ') });
  if (track.artworkUrl !== null) embed.setThumbnail(track.artworkUrl);

  return { embeds: [embed], components: controls(state.paused, false) };
}

export class ControllerMessage {
  readonly #client: Client;
  readonly #channelId: string;
  readonly #logger: Logger;

  #message: Message | null = null;
  #lastEditAt = 0;
  #pendingState: PlayerSnapshot | null = null;
  #trailingEdit: NodeJS.Timeout | undefined;
  #progressTick: NodeJS.Timeout | undefined;
  #destroyed = false;

  constructor(client: Client, guildId: string, channelId: string) {
    this.#client = client;
    this.#channelId = channelId;
    this.#logger = getLogger('controller').child({ guildId, channelId });
  }

  /** React to a player event. Non-blocking; failures only log. */
  onEvent(type: PlayerEventType, state: PlayerSnapshot | null): void {
    if (this.#destroyed) return;
    this.#pendingState = state;

    // Keep progress moving while a track plays without other activity.
    if (state?.current != null && !state.paused && this.#progressTick === undefined) {
      const tick = setInterval(() => {
        this.#scheduleEdit();
      }, PROGRESS_TICK_MS);
      tick.unref();
      this.#progressTick = tick;
    }
    if ((state?.current == null || state.paused) && this.#progressTick !== undefined) {
      clearInterval(this.#progressTick);
      this.#progressTick = undefined;
    }

    // Track starts refresh immediately; everything else respects the throttle.
    this.#scheduleEdit(type === 'TRACK_START');
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
    if (this.#trailingEdit !== undefined) clearTimeout(this.#trailingEdit);
    if (this.#progressTick !== undefined) clearInterval(this.#progressTick);
    // Leave a final idle card rather than a stale "now playing".
    await this.#applyEdit(null).catch(() => undefined);
  }

  #scheduleEdit(immediate = false): void {
    const since = Date.now() - this.#lastEditAt;
    if (immediate || since >= EDIT_THROTTLE_MS) {
      void this.#flush();
      return;
    }
    if (this.#trailingEdit !== undefined) return;
    const timer = setTimeout(() => {
      this.#trailingEdit = undefined;
      void this.#flush();
    }, EDIT_THROTTLE_MS - since);
    timer.unref();
    this.#trailingEdit = timer;
  }

  async #flush(): Promise<void> {
    if (this.#destroyed) return;
    this.#lastEditAt = Date.now();
    await this.#applyEdit(this.#pendingState).catch((error: unknown) => {
      this.#logger.debug({ err: error }, 'Controller update failed');
    });
  }

  async #applyEdit(state: PlayerSnapshot | null): Promise<void> {
    const payload = render(state);

    if (this.#message !== null) {
      try {
        await this.#message.edit(payload);
        return;
      } catch {
        // Deleted by a moderator or channel gone — recreate below.
        this.#message = null;
      }
    }

    const channel = await this.#client.channels.fetch(this.#channelId);
    if (channel?.isSendable() !== true) return;
    this.#message = await channel.send({
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
    });
  }
}

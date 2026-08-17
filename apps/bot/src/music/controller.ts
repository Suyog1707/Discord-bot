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
  StringSelectMenuBuilder,
  type Client,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageEditOptions,
} from 'discord.js';

import { getEnv } from '../config/env.js';
import { getLogger, type Logger } from '../lib/logger.js';
import { FILTER_LABELS, FILTER_PRESET_NAMES } from './filters.js';
import { MUSIC_BUTTON_PREFIX, MUSIC_FILTER_SELECT_ID } from './now-playing-view.js';

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

function controls(state: PlayerSnapshot | null, disabled: boolean) {
  const paused = state?.paused ?? false;
  const button = (id: string, emoji: string, style: ButtonStyle = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`${MUSIC_BUTTON_PREFIX}${id}`)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  const volumeRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    button('voldown', '🔉'),
    button('volup', '🔊'),
  );
  const dashboardUrl = getEnv().DASHBOARD_URL;
  if (dashboardUrl !== undefined) {
    volumeRow.addComponents(
      new ButtonBuilder()
        .setLabel('Dashboard')
        .setEmoji('🌐')
        .setStyle(ButtonStyle.Link)
        .setURL(`${dashboardUrl.replace(/\/$/u, '')}/dashboard`),
    );
  }

  const activeFilter = state?.activeFilter ?? null;
  const filterSelect = new StringSelectMenuBuilder()
    .setCustomId(MUSIC_FILTER_SELECT_ID)
    .setPlaceholder('🎚️ Filters, equalizer & speed')
    .setDisabled(disabled)
    .addOptions(
      {
        label: 'Normal (filters off)',
        value: 'off',
        default: activeFilter === null,
        emoji: '🎵',
      },
      ...FILTER_PRESET_NAMES.map((name) => ({
        label: FILTER_LABELS[name],
        value: `preset:${name}`,
        default: activeFilter === name,
      })),
      { label: 'Speed ×0.75', value: 'speed:0.75', default: false },
      { label: 'Speed ×1.25', value: 'speed:1.25', default: false },
      { label: 'Speed ×1.5', value: 'speed:1.5', default: false },
    );

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button('previous', '⏮️'),
      button('toggle', paused ? '▶️' : '⏸️', ButtonStyle.Primary),
      button('skip', '⏭️'),
      button('stop', '⏹️', ButtonStyle.Danger),
      button('shuffle', '🔀'),
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button('loop', '🔁'),
      button('favorite', '❤️'),
      button('queue', '📜'),
      button('lyrics', '🎵'),
      button(
        'autoplay',
        '♾️',
        state?.autoplayEnabled === true ? ButtonStyle.Success : ButtonStyle.Secondary,
      ),
    ),
    volumeRow,
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(filterSelect),
  ];
}

function render(state: PlayerSnapshot | null): MessageEditOptions {
  if (state?.current == null) {
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({ name: 'Nothing playing' })
      .setDescription('Start something with `/play` — this controller updates by itself.');
    return { embeds: [embed], components: controls(state, true) };
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
        name: 'Voice channel',
        value: state.voiceChannelId === null ? '—' : `<#${state.voiceChannelId}>`,
        inline: true,
      },
      {
        name: 'Progress',
        value: track.isStream
          ? '🔴 LIVE'
          : `${progressBar(state.positionMs, track.durationMs)}\n` +
            `${formatMs(state.positionMs)} / ${formatMs(track.durationMs)} · ` +
            `−${formatMs(Math.max(track.durationMs - state.positionMs, 0))} left`,
      },
    )
    .setFooter({ text: flags.join(' · ') });
  if (track.artworkUrl !== null) embed.setThumbnail(track.artworkUrl);

  if (state.upcomingTotal > 0) {
    const preview = state.upcoming
      .slice(0, 5)
      .map(
        (next, index) =>
          `\`${String(index + 1)}.\` ${next.uri === null ? next.title : `[${next.title}](${next.uri})`} — ${next.author}`,
      );
    if (state.upcomingTotal > 5) {
      preview.push(`…and ${String(state.upcomingTotal - 5)} more`);
    }
    embed.addFields({
      name: `Up next (${String(state.upcomingTotal)})`,
      value: preview.join('\n'),
    });
  }

  return { embeds: [embed], components: controls(state, false) };
}

export class ControllerMessage {
  readonly #client: Client;
  readonly #guildId: string;
  readonly #channelId: string;
  readonly #logger: Logger;

  /**
   * The one music GUI message this guild's player owns right now. Scoped to
   * this instance — the manager keeps one `ControllerMessage` per guild, so
   * guilds never share a reference.
   */
  #message: Message | null = null;
  #lastEditAt = 0;
  #pendingState: PlayerSnapshot | null = null;
  /**
   * A track started since the last applied update. The next apply must decide
   * whether the tracked GUI is still the channel's latest message and repost
   * a complete GUI when it is not, instead of editing a message the
   * conversation has moved past.
   */
  #reanchorPending = false;
  /**
   * Applies run strictly one at a time. Without this, rapid track changes
   * interleave the "is it still the latest? → send new" sequence and two
   * passes both conclude they must send — the uncontrolled-duplicate bug.
   */
  #applyChain: Promise<void> = Promise.resolve();
  #trailingEdit: NodeJS.Timeout | undefined;
  #progressTick: NodeJS.Timeout | undefined;
  #destroyed = false;

  constructor(client: Client, guildId: string, channelId: string) {
    this.#client = client;
    this.#guildId = guildId;
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

    // Track starts refresh immediately and re-evaluate where the GUI lives;
    // everything else edits the tracked message under the throttle.
    if (type === 'TRACK_START') this.#reanchorPending = true;
    this.#scheduleEdit(type === 'TRACK_START');
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
    if (this.#trailingEdit !== undefined) clearTimeout(this.#trailingEdit);
    if (this.#progressTick !== undefined) clearInterval(this.#progressTick);
    // Leave a final idle card rather than a stale "now playing" — behind the
    // chain so it cannot race an in-flight apply and lose.
    this.#applyChain = this.#applyChain.then(() => this.#applyEdit(null)).catch(() => undefined);
    await this.#applyChain;
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

  #flush(): Promise<void> {
    this.#lastEditAt = Date.now();
    // `#pendingState` is read when the apply RUNS, not when it is queued, so a
    // burst of track changes collapses into applies of the newest state.
    this.#applyChain = this.#applyChain
      .then(() => {
        if (this.#destroyed) return;
        return this.#applyEdit(this.#pendingState);
      })
      .catch((error: unknown) => {
        this.#logger.debug({ err: error }, 'Controller update failed');
      });
    return this.#applyChain;
  }

  /**
   * Whether the tracked GUI message is still the channel's most recent message
   * — the only case where editing it in place reads as "the player updated"
   * rather than "an old message quietly changed".
   */
  #isStillLatest(message: Message): boolean {
    const channel = message.channel;
    // Belongs to another channel or guild (music channel reconfigured, message
    // reference gone stale) — never edit across that boundary.
    if (channel.id !== this.#channelId) return false;
    if (message.inGuild() && message.guildId !== this.#guildId) return false;

    // `lastMessageId` is maintained by the gateway (GuildMessages intent).
    // Unknown means no evidence anyone has spoken since — keep the GUI.
    const lastId = channel.lastMessageId;
    return lastId === null || lastId === message.id;
  }

  async #applyEdit(state: PlayerSnapshot | null): Promise<void> {
    const payload = render(state);

    // A new song landing after other messages: abandon the old GUI (delete it,
    // best-effort — never edit it) and send a fresh, complete one below.
    if (this.#message !== null && this.#reanchorPending && !this.#isStillLatest(this.#message)) {
      const stale = this.#message;
      this.#message = null;
      void stale.delete().catch(() => undefined);
    }
    this.#reanchorPending = false;

    if (this.#message !== null) {
      try {
        await this.#message.edit(payload);
        return;
      } catch {
        // Deleted by a moderator or channel gone — recreate below.
        this.#message = null;
      }
    }

    // The GUI a fresh message carries is always the complete interface —
    // `render` returns the full embed and every control row.
    const channel = await this.#client.channels.fetch(this.#channelId);
    if (channel?.isSendable() !== true) return;
    this.#message = await channel.send({
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
    });
  }
}

/** `/nowplaying` — details and progress for the current track. */
import { EmbedBuilder, MessageFlags } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic } from '../../music/voice-context.js';

/** 12-slot progress bar: ▬▬▬🔘▬▬▬▬▬▬▬▬ */
export function renderProgressBar(positionMs: number, durationMs: number): string {
  const slots = 12;
  const ratio = durationMs > 0 ? Math.min(positionMs / durationMs, 1) : 0;
  const knob = Math.round(ratio * (slots - 1));
  return '▬'.repeat(knob) + '🔘' + '▬'.repeat(slots - 1 - knob);
}

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what is currently playing.'),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = interaction.guildId === null ? undefined : music.getPlayer(interaction.guildId);
    const current = player?.queue.current ?? null;

    if (player === undefined || current === null) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
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
    if (current.artworkUrl !== null) embed.setThumbnail(current.artworkUrl);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
});

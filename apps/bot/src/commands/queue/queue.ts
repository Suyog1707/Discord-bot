/** `/queue` — paginated view of the queue. */
import { EmbedBuilder } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic } from '../../music/voice-context.js';

const PAGE_SIZE = 10;

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue.')
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setMinValue(1),
    ),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = interaction.guildId === null ? undefined : music.getPlayer(interaction.guildId);

    if (
      player === undefined ||
      (player.queue.current === null && player.queue.upcoming.length === 0)
    ) {
      await interaction.editReply({
        content: 'The queue is empty. Add something with `/play`.',
      });
      return;
    }

    const { queue } = player;
    const upcoming = queue.upcoming;
    const totalPages = Math.max(Math.ceil(upcoming.length / PAGE_SIZE), 1);
    const page = Math.min(interaction.options.getInteger('page') ?? 1, totalPages);
    const start = (page - 1) * PAGE_SIZE;

    const lines = upcoming.slice(start, start + PAGE_SIZE).map((track, index) => {
      const position = start + index + 1;
      return `\`${String(position).padStart(2, ' ')}.\` ${trackLink(track)} \`${formatTrackDuration(track)}\` — ${track.requestedByName}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Queue')
      .setDescription(
        [
          queue.current === null
            ? null
            : `**Now:** ${trackLink(queue.current)} \`${formatTrackDuration(queue.current)}\``,
          lines.length > 0 ? lines.join('\n') : '*Nothing upcoming.*',
        ]
          .filter((part) => part !== null)
          .join('\n\n'),
      )
      .setFooter({
        text:
          `Page ${String(page)}/${String(totalPages)} · ` +
          `${String(upcoming.length)} upcoming · ` +
          `${formatTrackDuration({ durationMs: queue.upcomingDurationMs, isStream: false })} total` +
          (queue.loopMode === 'off' ? '' : ` · loop: ${queue.loopMode}`),
      });

    await interaction.editReply({ embeds: [embed] });
  },
});

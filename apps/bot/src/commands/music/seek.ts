/** `/seek` — jump to a position in the current track. */
import { ValidationError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration } from '../../music/track.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

/** Accepts `90`, `1:30` or `1:02:30`. */
export function parseTimestamp(input: string): number | null {
  const parts = input.split(':').map((part) => part.trim());
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/u.test(p))) return null;

  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  if (numbers.slice(1).some((value) => value >= 60)) return null;
  let seconds = 0;
  for (const value of numbers) seconds = seconds * 60 + value;
  return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null;
}

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a position in the current track.')
    .addStringOption((option) =>
      option
        .setName('position')
        .setDescription('Target position, e.g. 90, 1:30 or 1:02:30')
        .setRequired(true)
        .setMaxLength(10),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));

    const current = player.queue.current;
    if (current === null) {
      throw new ValidationError('Nothing is playing.');
    }
    if (current.isStream) {
      throw new ValidationError('Live streams cannot be seeked.');
    }

    const input = interaction.options.getString('position', true);
    const positionMs = parseTimestamp(input);
    if (positionMs === null) {
      throw new ValidationError('Use a position like `90`, `1:30` or `1:02:30`.');
    }
    if (positionMs > current.durationMs) {
      throw new ValidationError(
        `That is past the end — the track is ${formatTrackDuration(current)} long.`,
      );
    }

    await player.seekTo(positionMs);
    await interaction.editReply({
      content: `⏩ Jumped to **${formatTrackDuration({ durationMs: positionMs, isStream: false })}**.`,
    });
  },
});

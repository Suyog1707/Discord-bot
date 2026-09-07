/** `/remove` — remove one upcoming track by its queue position. */
import { ValidationError } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  denyUnlessDjOrOwnTrack,
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue.')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Queue position as shown by /queue (1 = next up)')
        .setMinValue(1)
        .setRequired(true),
    ),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,
  // Taking back a track you queued yourself needs no DJ.
  ownTrackExempt: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));

    const position = interaction.options.getInteger('position', true);

    // Check before removing: authority depends on whose track it is, so the
    // target has to be read while it is still in the queue.
    const target = player.queue.upcoming[position - 1] ?? null;
    const denial = await denyUnlessDjOrOwnTrack(interaction, target);
    if (denial !== null) {
      await interaction.editReply({ content: denial });
      return;
    }

    const removed = player.removeUpcoming(position - 1);

    if (removed === null) {
      throw new ValidationError(
        `Nothing at position ${String(position)} — the queue has ${String(player.queue.upcoming.length)} upcoming track(s).`,
      );
    }

    await interaction.editReply({
      content: `🗑️ Removed **${removed.title}**.`,
    });
  },
});

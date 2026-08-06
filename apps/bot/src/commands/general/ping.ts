/**
 * `/ping` — scaffold smoke test.
 *
 * Exists so Phase 1 can verify the full path end to end: registry discovery →
 * deployment payload → gateway dispatch → reply. The real command surface
 * arrives in Phase 3.
 */
import { MessageFlags } from 'discord.js';

import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is responsive and view its latency.'),
  category: 'general',
  cooldownSeconds: 5,

  async execute({ interaction }) {
    const sent = await interaction.reply({
      content: 'Pinging…',
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });

    const roundTripMs =
      (sent.resource?.message?.createdTimestamp ?? Date.now()) - interaction.createdTimestamp;
    // -1 means the heartbeat has not completed yet, right after connecting.
    const websocketMs = Math.round(interaction.client.ws.ping);

    await interaction.editReply({
      content: [
        '**Pong!**',
        `Round trip: \`${String(roundTripMs)}ms\``,
        `WebSocket: ${websocketMs < 0 ? '`measuring…`' : `\`${String(websocketMs)}ms\``}`,
      ].join('\n'),
    });
  },
});

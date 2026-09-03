/**
 * `/ping` — scaffold smoke test.
 *
 * Exists so Phase 1 can verify the full path end to end: registry discovery →
 * deployment payload → gateway dispatch → reply. The real command surface
 * arrives in Phase 3.
 */

import { defineCommand, SlashCommandBuilder } from '../../core/command.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is responsive and view its latency.'),
  category: 'general',
  cooldownSeconds: 5,

  async execute({ interaction }) {
    // The interaction is already acknowledged by the time execute runs, so the
    // round trip is measured against the first message we actually put on the
    // channel — which now includes the deferral the user really waited for.
    const sent = await interaction.editReply({ content: 'Pinging…' });

    const roundTripMs = sent.createdTimestamp - interaction.createdTimestamp;
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

/** `/loop` — set the loop mode. */
import { LOOP_MODES, type LoopMode } from '@discord-music/shared';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

const DESCRIPTIONS: Record<LoopMode, string> = {
  off: 'Looping disabled.',
  track: '🔂 Looping the current track.',
  queue: '🔁 Looping the whole queue.',
};

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Loop the current track, the whole queue, or turn looping off.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(...LOOP_MODES.map((mode) => ({ name: mode, value: mode }))),
    ),
  category: 'queue',
  guildOnly: true,
  cooldownSeconds: 2,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const player = requireActivePlayer(music, requireVoiceContext(interaction));

    const mode = interaction.options.getString('mode', true) as LoopMode;
    player.setLoopMode(mode);

    await interaction.editReply({ content: DESCRIPTIONS[mode] });
  },
});

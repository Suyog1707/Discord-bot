/** `/filter` — audio filter presets, speed and pitch. */

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  FILTER_LABELS,
  FILTER_PRESET_NAMES,
  FILTER_PRESETS,
  pitchFilter,
  speedFilter,
  TIMESCALE_LIMITS,
} from '../../music/filters.js';
import {
  requireActivePlayer,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Audio filters.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('preset')
        .setDescription('Apply a filter preset.')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('The preset to apply')
            .setRequired(true)
            .addChoices(
              ...FILTER_PRESET_NAMES.map((name) => ({ name: FILTER_LABELS[name], value: name })),
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('speed')
        .setDescription('Change playback speed without changing pitch.')
        .addNumberOption((option) =>
          option
            .setName('value')
            .setDescription('Speed multiplier (1.0 = normal)')
            .setMinValue(TIMESCALE_LIMITS.SPEED_MIN)
            .setMaxValue(TIMESCALE_LIMITS.SPEED_MAX)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('pitch')
        .setDescription('Change pitch without changing speed.')
        .addNumberOption((option) =>
          option
            .setName('value')
            .setDescription('Pitch multiplier (1.0 = normal)')
            .setMinValue(TIMESCALE_LIMITS.PITCH_MIN)
            .setMaxValue(TIMESCALE_LIMITS.PITCH_MAX)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Remove all filters.'))
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Show the active filter.'),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,
  djOnly: true,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const router = requireRouter(client);
    const player = requireActivePlayer(router, requireVoiceContext(interaction));
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === 'status') {
      const active = player.activeFilter;
      const label =
        active === null
          ? 'No filter active — clean playback.'
          : active === 'speed' || active === 'pitch'
            ? `Custom ${active} filter active.`
            : `**${FILTER_LABELS[active]}** is active.`;
      await interaction.editReply({ content: label });
      return;
    }

    if (subcommand === 'off') {
      await player.setFilter(null, {});
      await interaction.editReply({ content: '🎚️ Filters removed.' });
      return;
    }

    if (subcommand === 'speed' || subcommand === 'pitch') {
      const value = interaction.options.getNumber('value', true);
      await player.setFilter(
        subcommand,
        subcommand === 'speed' ? speedFilter(value) : pitchFilter(value),
      );
      await interaction.editReply({
        content: `🎚️ ${subcommand === 'speed' ? 'Speed' : 'Pitch'} set to ${String(value)}×.`,
      });
      return;
    }

    const name = interaction.options.getString('name', true) as keyof typeof FILTER_PRESETS;
    await player.setFilter(name, FILTER_PRESETS[name]);
    await interaction.editReply({
      content: `🎚️ **${FILTER_LABELS[name]}** applied. Remove with \`/filter off\`.`,
    });
  },
});

/**
 * `/dislike` — "not like": tell autoplay never to recommend a song again.
 *
 * Different from `/skip` on purpose. A skip says "not right now" and only
 * nudges the ranking; a dislike is remembered for good, keyed by the song's
 * canonical identity so it stays disliked whichever provider would stream
 * it, and it is pulled out of the queue and the prefetch buffer immediately.
 */
import { NotFoundError, ValidationError } from '@discord-music/shared';
import { EmbedBuilder } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActiveRoom,
  requireRouter,
  requireVoiceContext,
} from '../../music/voice-context.js';

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('dislike')
    .setDescription('Not like: never recommend a song again.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Dislike the playing track, or an upcoming one by its queue number.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Position in the upcoming queue (omit for the playing track)')
            .setMinValue(1),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('Show the songs you have disliked.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Forgive a song by its number from /dislike list.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Position from /dislike list')
            .setMinValue(1)
            .setRequired(true),
        ),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 2,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const subcommand = interaction.options.getSubcommand(true);
    const user = interaction.user;

    if (subcommand === 'list') {
      const disliked = await client.services.dislikes.list(user.id);
      if (disliked.length === 0) {
        throw new NotFoundError('You have not disliked anything yet — use `/dislike add` or 👎.');
      }
      const lines = disliked.map(
        (entry, index) => `**${String(index + 1)}.** ${entry.title} — ${entry.author}`,
      );
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `${user.username}'s "not like" list` })
        .setDescription(lines.join('\n'));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === 'remove') {
      const number = interaction.options.getInteger('number', true);
      const disliked = await client.services.dislikes.list(user.id);
      const target = disliked[number - 1];
      if (target === undefined) {
        throw new ValidationError(
          `Nothing at number ${String(number)} — you have ${String(disliked.length)} dislike(s).`,
        );
      }
      await client.services.dislikes.remove(user.id, target.trackKey);
      // The session mirror would otherwise keep the song excluded here until
      // its TTL, long after the durable record is gone.
      if (interaction.guildId !== null) {
        await client.ai.session.forgetDisliked(interaction.guildId, [target.trackKey]);
      }
      await interaction.editReply({
        content: `🗑️ **${target.title}** may be recommended again.`,
      });
      return;
    }

    // add — a database write plus a Lavalink skip, both well past Discord's
    // three-second window. The framework has already acknowledged.
    const { player, music } = requireActiveRoom(
      requireRouter(client),
      requireVoiceContext(interaction),
    );
    const number = interaction.options.getInteger('number');
    const target =
      number === null ? player.queue.current : (player.queue.upcoming[number - 1] ?? null);
    if (target === null) {
      throw new NotFoundError(
        number === null
          ? 'Nothing is playing to dislike.'
          : `There is no upcoming track ${String(number)}.`,
      );
    }

    const persisted = await client.services.dislikes.add(
      user.id,
      user.username,
      {
        title: target.title,
        author: target.author,
        ...(target.sourceKey === undefined ? {} : { trackKey: target.sourceKey }),
      },
      'command',
    );
    // Live effect: out of the queue, out of the buffer, excluded from the
    // next generation — then, if it is the one playing, skip it.
    const applied = music.applyDislike(player.guildId, target);
    // Re-checked after the awaits: the queue may have advanced meanwhile, and
    // the reply must describe what actually happened.
    const wasPlaying = player.queue.current === target;
    if (wasPlaying) await player.skip();
    const effect = wasPlaying
      ? ' Skipped.'
      : applied.removedFromQueue > 0
        ? ' Removed from the queue.'
        : '';

    await interaction.editReply({
      content:
        (persisted
          ? `👎 Won't recommend **${target.title}** again.`
          : `**${target.title}** was already on your "not like" list.`) + effect,
    });
  },
});

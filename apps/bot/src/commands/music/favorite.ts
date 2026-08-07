/** `/favorite` — save, list, play and remove personal favorite tracks. */
import { NotFoundError, ValidationError } from '@discord-music/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import {
  requireActivePlayer,
  requireMusic,
  requireVoiceContext,
} from '../../music/voice-context.js';

/** How many favorites `/favorite play` enqueues at once. */
const PLAY_BATCH = 25;

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('favorite')
    .setDescription('Your favorite tracks.')
    .addSubcommand((subcommand) =>
      subcommand.setName('add').setDescription('Save the currently playing track.'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('Show your saved favorites.'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('play').setDescription('Queue your favorites in this channel.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a favorite by its list number.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Position from /favorite list')
            .setMinValue(1)
            .setRequired(true),
        ),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 3,

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const subcommand = interaction.options.getSubcommand(true);
    const user = interaction.user;

    if (subcommand === 'add') {
      const music = requireMusic(client);
      const player = requireActivePlayer(music, requireVoiceContext(interaction));
      const track = player.queue.current;
      if (track === null) throw new NotFoundError('Nothing is playing to save.');

      const added = await client.services.favorites.add(user.id, user.username, track);
      await interaction.reply({
        content: added
          ? `⭐ Saved **${track.title}** to your favorites.`
          : `**${track.title}** is already in your favorites.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'list') {
      const favorites = await client.services.favorites.list(user.id);
      if (favorites.length === 0) {
        throw new NotFoundError('You have no favorites yet — save one with `/favorite add`.');
      }

      const lines = favorites.map(
        (favorite, index) => `**${String(index + 1)}.** ${favorite.title} — ${favorite.author}`,
      );
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `${user.username}'s favorites` })
        .setDescription(lines.join('\n'));
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'remove') {
      const number = interaction.options.getInteger('number', true);
      const favorites = await client.services.favorites.list(user.id);
      const target = favorites[number - 1];
      if (target === undefined) {
        throw new ValidationError(
          `Nothing at number ${String(number)} — you have ${String(favorites.length)} favorite(s).`,
        );
      }

      await client.services.favorites.remove(user.id, target.identifier);
      await interaction.reply({
        content: `🗑️ Removed **${target.title}** from your favorites.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // play
    const music = requireMusic(client);
    const context = requireVoiceContext(interaction);
    const favorites = await client.services.favorites.list(user.id, PLAY_BATCH);
    if (favorites.length === 0) {
      throw new NotFoundError('You have no favorites yet — save one with `/favorite add`.');
    }

    await interaction.deferReply();

    const player = await music.getOrCreatePlayer({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });

    // Re-resolve each favorite: stored Lavalink identifiers go stale, but the
    // URI (or a title+author search) stays valid indefinitely.
    const requester = { id: user.id, name: user.username };
    let queued = 0;
    for (const favorite of favorites) {
      try {
        const result = await music.resolve(
          favorite.uri ?? `${favorite.title} ${favorite.author}`,
          requester,
        );
        const [track] = result.tracks;
        if (track !== undefined) {
          await player.enqueue([track]);
          queued += 1;
        }
      } catch {
        // One dead link must not sink the batch.
      }
    }

    if (queued === 0) {
      throw new NotFoundError('None of your favorites could be resolved right now.');
    }

    await interaction.editReply(
      `⭐ Queued **${String(queued)}** of your ${String(favorites.length)} favorite(s).`,
    );
  },
});

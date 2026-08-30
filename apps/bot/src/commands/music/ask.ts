/**
 * `/ask` — describe what you want to hear instead of naming a track.
 *
 * "play something chill like what I listen to at night", "queue 250 punjabi
 * songs", "more like this but not the same artist". One model call turns the
 * sentence into a structured request; everything after that is local ranking
 * over a batched candidate pool, so asking for 250 tracks costs the same one
 * call as asking for 5.
 *
 * When the parser decides the user actually named something concrete, this hands
 * straight off to the ordinary resolver — a lookup should never pay for a
 * recommendation it does not need.
 */
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

import type { BotClient } from '../../core/bot-client.js';
import { defineCommand, SlashCommandBuilder } from '../../core/command.js';
import { formatTrackDuration, trackLink } from '../../music/track.js';
import { requireMusic, requireVoiceContext } from '../../music/voice-context.js';

/** Beyond this a single reply cannot usefully describe what was queued. */
const PREVIEW_TRACKS = 5;

export default defineCommand({
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Describe what you want to hear and let the bot build the queue.')
    .addStringOption((option) =>
      option
        .setName('request')
        .setDescription('e.g. "queue 50 chill hindi songs I haven\'t heard recently"')
        .setRequired(true)
        .setMaxLength(400),
    ),
  category: 'music',
  guildOnly: true,
  cooldownSeconds: 5,
  djOnly: true,
  botPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
  // Recommendation is slower than the three-second interaction window even in
  // the good case, so the dispatcher acknowledges before any of it starts.
  deferral: 'public',

  async execute({ interaction }) {
    const client = interaction.client as BotClient;
    const music = requireMusic(client);
    const request = interaction.options.getString('request', true);
    // A question needs no voice channel — only a request to play does, and
    // that is decided below, once the sentence has been read.
    const guildId = interaction.guildId ?? '';

    const requestedBy = {
      id: interaction.user.id,
      name:
        interaction.member !== null && 'displayName' in interaction.member
          ? interaction.member.displayName
          : interaction.user.username,
    };

    // Seed from what the room is already listening to, so "more like this"
    // has a "this" to work from.
    const existing = music.getPlayer(guildId);
    const seeds = [existing?.queue.current, ...(existing?.queue.tracks.slice(-3) ?? [])]
      .filter((track): track is NonNullable<typeof track> => track != null)
      .map((track) => ({
        title: track.title,
        artist: track.author,
        identifier: track.identifier,
      }));
    const current = existing?.queue.current ?? null;

    // Decide first, without touching a playback provider: a question is
    // answered right here and never joins voice or searches for audio.
    const outcome = await client.ai.orchestrator.ask({
      guildId,
      userId: interaction.user.id,
      text: request,
      seeds,
      current: current === null ? undefined : { title: current.title, artist: current.author },
    });

    if (outcome.plan.kind === 'inform') {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ name: 'About that' })
            .setDescription(outcome.plan.answer),
        ],
      });
      return;
    }

    const context = requireVoiceContext(interaction);
    const player = await music.getOrCreatePlayer({
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: interaction.channelId,
      shardId: interaction.guild?.shardId ?? 0,
    });

    // The parser decided this was a plain lookup — run it through the normal
    // path so URLs, playlists and Spotify links all keep working as usual.
    if (outcome.plan.kind === 'direct') {
      const resolved = await music.resolve(outcome.plan.query, requestedBy);
      const { startedPlayback } = await player.enqueue(resolved.tracks);
      const [first] = resolved.tracks;
      if (first === undefined) {
        await interaction.editReply('I could not find anything for that.');
        return;
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ name: startedPlayback ? 'Now playing' : 'Added to queue' })
            .setDescription(`${trackLink(first)} — ${first.author}`)
            .addFields({
              name: 'Duration',
              value: formatTrackDuration(first),
              inline: true,
            }),
        ],
      });
      return;
    }

    // A recommendation is the one /ask outcome that genuinely needs playback:
    // the songs it picks have to become audio, through the same SoundCloud →
    // YouTube walk everything else uses.
    const generated = await client.ai.orchestrator.recommend(
      {
        guildId: context.guildId,
        userId: interaction.user.id,
        seeds,
        count: outcome.intent.quantity,
        intent: outcome.intent,
      },
      async (candidate) => music.resolveCandidate(candidate),
    );

    if (generated.tracks.length === 0) {
      await interaction.editReply(
        'I understood the request but could not find tracks for it. ' +
          'Try naming an artist or genre, or play a song first so I have something to work from.',
      );
      return;
    }

    // Re-stamp the requester: the engine builds tracks attributed to autoplay,
    // but these were asked for by a person and the queue should say so.
    const attributed = generated.tracks.map(({ autoplayKind: _kind, ...track }) => ({
      ...track,
      requestedById: requestedBy.id,
      requestedByName: requestedBy.name,
      // Asked for by a person: these are their taste anchors, count toward
      // their history and can make them the session's listener.
      origin: 'user' as const,
    }));

    const { startedPlayback } = await player.enqueue(attributed);

    const intent = outcome.intent;
    const descriptors = [intent.language, ...intent.mood, ...intent.genre, intent.activity].filter(
      (value): value is string => value != null && value.length > 0,
    );

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: startedPlayback ? 'Now playing your request' : 'Queued your request' })
      .setDescription(
        `**${String(attributed.length)}** track(s)` +
          (descriptors.length === 0 ? '' : ` · ${descriptors.join(', ')}`),
      )
      .addFields({
        name: 'Starting with',
        value: attributed
          .slice(0, PREVIEW_TRACKS)
          .map((track, index) => `${String(index + 1)}. ${trackLink(track)} — ${track.author}`)
          .join('\n'),
      });

    // Asked for more than could be found: say so rather than letting the user
    // discover a short queue themselves.
    if (attributed.length < intent.quantity) {
      embed.addFields({
        name: 'Shorter than requested',
        value:
          `You asked for ${String(intent.quantity)}. I found ${String(attributed.length)} that ` +
          'fit without repeating the same artists — try a broader request for more.',
      });
    }

    await interaction.editReply({ embeds: [embed] });

    client.logger.debug(
      {
        guildId: context.guildId,
        ...outcome.timings,
        ...generated.timings,
        strategies: generated.strategies,
      },
      'Ask pipeline timings',
    );

    if (client.ai.orchestrator.services.lastfm.enabled) return;
    await interaction.followUp({
      content:
        'Tip: recommendations are running without Last.fm, so they are based on ' +
        'listening history alone. Set `LASTFM_API_KEY` for much better results.',
      flags: MessageFlags.Ephemeral,
    });
  },
});

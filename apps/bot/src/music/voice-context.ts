/**
 * Voice-context guards shared by every music command.
 *
 * These throw `AppError`s with user-facing messages; the central dispatcher
 * turns them into ephemeral replies, so commands read as straight-line logic.
 */
import { UpstreamError, ValidationError } from '@discord-music/shared';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';

import type { BotClient } from '../core/bot-client.js';
import { checkDjAuthority } from '../core/guards.js';
import type { GuildPlayer } from './guild-player.js';
import type { MusicManager } from './music-manager.js';
import { trackOrigin, type QueuedTrack } from './track.js';

/** The music engine, or a clear message when Lavalink is not configured. */
export function requireMusic(client: BotClient): MusicManager {
  if (client.music === undefined) {
    throw new UpstreamError(
      'Music is not enabled on this bot instance (no audio server configured).',
    );
  }
  return client.music;
}

export interface VoiceContext {
  readonly guildId: string;
  readonly member: GuildMember;
  readonly voiceChannelId: string;
}

/** The invoking member must be in a voice channel in this guild. */
export function requireVoiceContext(interaction: ChatInputCommandInteraction): VoiceContext {
  const { guildId } = interaction;
  const member = interaction.member as GuildMember | null;

  if (guildId === null || member === null) {
    throw new ValidationError('This command can only be used in a server.');
  }

  const voiceChannelId = member.voice.channelId;
  if (voiceChannelId === null) {
    throw new ValidationError('Join a voice channel first.');
  }

  return { guildId, member, voiceChannelId };
}

/**
 * An active player for this guild, with the member in the *same* channel —
 * controlling music from another room is how queue wars start.
 */
export function requireActivePlayer(music: MusicManager, context: VoiceContext): GuildPlayer {
  const player = music.getPlayer(context.guildId);
  if (player === undefined) {
    throw new ValidationError('Nothing is playing. Start something with `/play`.');
  }
  if (player.voiceChannelId !== context.voiceChannelId) {
    throw new ValidationError('You need to be in my voice channel to control playback.');
  }
  return player;
}

/**
 * Let a DJ act, or anyone act on a track they queued themselves.
 *
 * A misclicked `/play` should not need a DJ to clean up, so the person who put
 * a track on may always take it back off. Ownership is only meaningful for
 * user-requested tracks: every autoplay pick is stamped with a placeholder
 * requester, and nobody owns the robot's choices.
 *
 * @returns the rejection message, or null when the caller may proceed.
 */
export async function denyUnlessDjOrOwnTrack(
  interaction: ChatInputCommandInteraction,
  track: QueuedTrack | null,
): Promise<string | null> {
  const owned =
    track !== null && trackOrigin(track) === 'user' && track.requestedById === interaction.user.id;
  if (owned) return null;

  const verdict = await checkDjAuthority(interaction.client as BotClient, interaction);
  if (verdict.allowed) return null;
  return verdict.message ?? 'You do not have permission to do that.';
}

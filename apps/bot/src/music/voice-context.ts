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
import type { IntentResult, RoomIntent } from './intent.js';
import type { PlayerRouter } from './player-router.js';
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

/**
 * The fleet router, or the same clear message when there is no audio server.
 *
 * Players live behind the router rather than on one manager: a guild can have
 * several rooms going at once, each served by a different bot, and only the
 * router knows which. Use this wherever a *player* is wanted; `requireMusic`
 * remains for the resolution work, which is bot-agnostic.
 */
export function requireRouter(client: BotClient): PlayerRouter {
  if (client.router === undefined) {
    throw new UpstreamError(
      'Music is not enabled on this bot instance (no audio server configured).',
    );
  }
  return client.router;
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
 * The player for the room the caller is standing in.
 *
 * Looking a player up *by the caller's own channel* is what keeps rooms apart:
 * a command can only ever reach the music in the channel its author is in, so
 * one room's controls can never touch another's. The old same-channel check
 * that made this true is now the lookup itself.
 */
export function requireActivePlayer(router: PlayerRouter, context: VoiceContext): GuildPlayer {
  const player = router.playerFor(context.guildId, context.voiceChannelId);
  if (player !== undefined) return player;

  // Distinguish "nothing is playing here" from "something is playing, but not
  // in your channel" — the second is otherwise a baffling error for someone
  // who can plainly hear the bot in the room next door.
  const elsewhere = router.roomsIn(context.guildId);
  if (elsewhere.length === 0) {
    throw new ValidationError('Nothing is playing. Start something with `/play`.');
  }
  throw new ValidationError(
    `Nothing is playing in your channel. I'm in ${elsewhere
      .map((room) => `<#${room.voiceChannelId}>`)
      .join(', ')} — join one of those, or start your own with \`/play\`.`,
  );
}

/**
 * The room a channel-less command is about.
 *
 * `/nowplaying`, `/queue` and friends carry no voice channel, and with several
 * rooms playing in one server "the player" stops being a thing that exists.
 * The caller's own channel answers it when they are in one; a server with a
 * single room going answers it too. Anything else is genuinely ambiguous and
 * says so rather than picking one at random.
 *
 * @returns the player, or undefined when nothing is playing at all.
 */
export function resolveRoomPlayer(
  router: PlayerRouter,
  interaction: ChatInputCommandInteraction,
): GuildPlayer | undefined {
  const { guildId } = interaction;
  if (guildId === null) return undefined;

  const member = interaction.member as GuildMember | null;
  const ownChannel = member?.voice.channelId ?? null;
  if (ownChannel !== null) {
    const mine = router.playerFor(guildId, ownChannel);
    if (mine !== undefined) return mine;
  }

  const rooms = router.roomsIn(guildId);
  if (rooms.length === 0) return undefined;
  if (rooms.length === 1) return rooms[0]?.player;

  throw new ValidationError(
    `I'm playing in ${rooms
      .map((room) => `<#${room.voiceChannelId}>`)
      .join(', ')} — join the one you mean, and ask again.`,
  );
}

/**
 * The caller's room, with the manager that owns it.
 *
 * Use this instead of {@link requireActivePlayer} whenever the command reaches
 * past the player itself — the owning bot's manager is not interchangeable
 * with the primary's.
 */
export function requireActiveRoom(
  router: PlayerRouter,
  context: VoiceContext,
): { readonly player: GuildPlayer; readonly music: MusicManager } {
  const player = requireActivePlayer(router, context);
  const room = router.roomFor(context.guildId, context.voiceChannelId);
  if (room === undefined) {
    throw new ValidationError('Nothing is playing. Start something with `/play`.');
  }
  return { player, music: room.music };
}

/** The three fields every intent carries, from a context the command already has. */
export function intentTarget(
  context: VoiceContext,
  issuedBy: string,
): { readonly guildId: string; readonly voiceChannelId: string; readonly issuedBy: string } {
  return { guildId: context.guildId, voiceChannelId: context.voiceChannelId, issuedBy };
}

/**
 * Run an intent against the caller's room and turn a failure into a message.
 *
 * Commands care about two things: did it work, and what do I say. Where the
 * room actually lives — this process or a sibling container — is the router's
 * business, and an unreachable player reads as an ordinary refusal rather than
 * as a crash.
 *
 * @returns the result, or null once the failure has been replied to.
 */
export async function runRoomIntent(
  router: PlayerRouter,
  interaction: ChatInputCommandInteraction,
  intent: RoomIntent,
): Promise<IntentResult | null> {
  const result = await router.runIntent(intent);
  if (result.kind !== 'error') return result;

  await interaction.editReply({ content: result.message });
  return null;
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

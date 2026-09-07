/**
 * Pre-execution command guards.
 *
 * Every check a command can declare (`guildOnly`, permissions, cooldown,
 * `djOnly`) is enforced here, in one place, before `execute` runs. Guards
 * return a rejection message rather than throwing: a failed guard is normal
 * flow, not an error.
 */
import {
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type GuildMember,
  type PermissionResolvable,
} from 'discord.js';

import { decideDjAuthority } from '../music/session-dj.js';
import { getLogger } from '../lib/logger.js';
import type { CommandDefinition } from './command.js';
import type { BotClient } from './bot-client.js';

const logger = getLogger('guards');

/**
 * Longest the DJ check may wait on Postgres for a guild it has never read.
 *
 * Guards run before the command replies, so this competes directly with
 * Discord's three-second acknowledgement window.
 */
const DJ_SETTINGS_BUDGET_MS = 800;

export interface GuardResult {
  readonly allowed: boolean;
  /** User-facing reason when rejected. */
  readonly message?: string;
}

const ALLOWED: GuardResult = { allowed: true };

function denied(message: string): GuardResult {
  return { allowed: false, message };
}

function formatPermissions(permissions: readonly PermissionResolvable[]): string {
  return new PermissionsBitField([...permissions])
    .toArray()
    .map((name) => `\`${name}\``)
    .join(', ');
}

/**
 * Run all guards for a command invocation, in cheap-to-expensive order:
 * context checks → Discord permissions → cooldown (Redis) → DJ role (DB).
 */
export async function runGuards(
  client: BotClient,
  command: CommandDefinition,
  interaction: ChatInputCommandInteraction,
): Promise<GuardResult> {
  if (command.guildOnly === true && !interaction.inGuild()) {
    return denied('This command can only be used in a server.');
  }

  // Discord permission checks only make sense inside a guild.
  if (interaction.inGuild()) {
    const member = interaction.member as GuildMember | null;

    if (command.userPermissions !== undefined && command.userPermissions.length > 0) {
      const missing = member?.permissions.missing(new PermissionsBitField(command.userPermissions));
      if (missing === undefined || missing.length > 0) {
        return denied(
          `You need the following permission(s) to do that: ${formatPermissions(
            command.userPermissions,
          )}.`,
        );
      }
    }

    if (command.botPermissions !== undefined && command.botPermissions.length > 0) {
      const me = interaction.guild?.members.me;
      const missing = me?.permissions.missing(new PermissionsBitField(command.botPermissions));
      if (missing === undefined || missing.length > 0) {
        return denied(
          `I am missing the following permission(s): ${formatPermissions(command.botPermissions)}. ` +
            'Ask a server admin to update my role.',
        );
      }
    }
  }

  const cooldownSeconds = command.cooldownSeconds ?? 0;
  if (cooldownSeconds > 0) {
    const result = await client.cooldowns.consume(
      command.data.name,
      interaction.user.id,
      cooldownSeconds,
    );
    if (!result.allowed) {
      return denied(
        `You're doing that too fast — try again in ${String(result.retryAfterSeconds)}s.`,
      );
    }
  }

  // `ownTrackExempt` commands run their own check once they know which track
  // is meant — see the field's docs on `CommandDefinition`.
  if (command.djOnly === true && command.ownTrackExempt !== true && interaction.inGuild()) {
    const verdict = await checkDjAuthority(client, interaction);
    if (!verdict.allowed) return verdict;
  }

  return ALLOWED;
}

/**
 * DJ gate.
 *
 * Control of a session belongs to whoever summoned the bot, to the people
 * they hand it to, and to anyone holding the standing DJ configuration — but
 * all three only inside the voice channel the bot is actually playing in. A DJ
 * role is not a guild-wide grant: holding it while sitting in another channel
 * says nothing about this room's music. Manage Server is the one exception,
 * left unscoped so an admin can always stop a bot that is misbehaving.
 *
 * The settings read is bounded (see {@link DJ_SETTINGS_BUDGET_MS}). If Postgres
 * cannot answer within the budget for a guild we have never read, the command
 * is allowed through: the DJ gate is a convenience restriction, and blocking
 * every music command whenever the database is slow is the worse failure.
 */
export async function checkDjAuthority(
  client: BotClient,
  interaction: ChatInputCommandInteraction,
): Promise<GuardResult> {
  const guildId = interaction.guildId;
  if (guildId === null) return ALLOWED;

  const settings = await client.services.guilds.getSettingsWithin(guildId, DJ_SETTINGS_BUDGET_MS);
  if (settings === null) {
    logger.warn(
      { guildId, budgetMs: DJ_SETTINGS_BUDGET_MS },
      'DJ check timed out reading settings; allowing the command through',
    );
    return ALLOWED;
  }

  const member = interaction.member as GuildMember | null;
  if (member === null) return denied('Could not verify your permissions. Try again.');

  /**
   * The room the member is standing in, not "the guild's player" — with
   * several channels playing at once there is no such thing, and asking the
   * primary would judge this member against a different room's host and DJs.
   */
  const memberVoiceChannelId = member.voice.channelId;
  const room =
    memberVoiceChannelId === null
      ? undefined
      : client.router?.roomFor(guildId, memberVoiceChannelId);
  const botVoiceChannelId = room?.player.voiceChannelId ?? null;
  const registry = room?.music.sessionDj;

  const verdict = decideDjAuthority({
    memberId: member.id,
    memberVoiceChannelId,
    botVoiceChannelId,
    hasManageGuild: member.permissions.has(PermissionsBitField.Flags.ManageGuild),
    hostId: registry?.host(guildId) ?? null,
    sessionDjIds: registry?.djIds(guildId) ?? [],
    memberRoleIds: [...member.roles.cache.keys()],
    djRoleId: settings.djRoleId,
    djUserIds: settings.djUserIds,
  });

  if (verdict === 'allowed') return ALLOWED;
  if (verdict === 'not-in-channel') {
    return denied('Join the voice channel the bot is playing in to control playback.');
  }

  const host = registry?.host(guildId) ?? null;
  if (host !== null) {
    return denied(
      `Only <@${host}> and the DJs they picked can do that. Ask them for DJ with \`/dj add\`, or queue a song with \`/play\`.`,
    );
  }
  return settings.djRoleId === null
    ? denied("That command is restricted to this server's DJs.")
    : denied(`That command is restricted to the <@&${settings.djRoleId}> role.`);
}

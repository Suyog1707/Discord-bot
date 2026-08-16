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

  if (command.djOnly === true && interaction.inGuild()) {
    const verdict = await checkDjRole(client, interaction);
    if (!verdict.allowed) return verdict;
  }

  return ALLOWED;
}

/**
 * DJ gate: when a DJ role is configured, restrict the command to members who
 * hold it (or can Manage Server, so admins are never locked out). With no DJ
 * role configured, everyone passes.
 *
 * The settings read is bounded (see {@link DJ_SETTINGS_BUDGET_MS}). If Postgres
 * cannot answer within the budget for a guild we have never read, the command
 * is allowed through: the DJ role is a convenience restriction, and blocking
 * every music command whenever the database is slow is the worse failure.
 */
async function checkDjRole(
  client: BotClient,
  interaction: ChatInputCommandInteraction,
): Promise<GuardResult> {
  if (interaction.guildId === null) return ALLOWED;

  const settings = await client.services.guilds.getSettingsWithin(
    interaction.guildId,
    DJ_SETTINGS_BUDGET_MS,
  );
  if (settings === null) {
    logger.warn(
      { guildId: interaction.guildId, budgetMs: DJ_SETTINGS_BUDGET_MS },
      'DJ role check timed out reading settings; allowing the command through',
    );
    return ALLOWED;
  }
  if (settings.djRoleId === null) return ALLOWED;

  const member = interaction.member as GuildMember | null;
  if (member === null) return denied('Could not verify your roles. Try again.');

  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return ALLOWED;
  if (member.roles.cache.has(settings.djRoleId)) return ALLOWED;

  return denied(`This command is restricted to the <@&${settings.djRoleId}> role.`);
}

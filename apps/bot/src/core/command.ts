/**
 * Slash-command contract.
 *
 * Every command is declared with `defineCommand`, which pins the shape at the
 * type level so the registry can load, validate and dispatch commands without
 * per-command special cases (PROJECT_RULES.md: "No duplicate code").
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionResolvable,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { SlashCommandBuilder } from 'discord.js';

import type { Logger } from '../lib/logger.js';

/** Any of the builder shapes `SlashCommandBuilder` narrows to once options are added. */
export type AnySlashCommandBuilder =
  SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

/** Grouping used for `/help` and for organising `src/commands/<category>/`. */
export const COMMAND_CATEGORIES = ['general', 'music', 'queue', 'playlist', 'settings'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/** Everything a handler needs, passed explicitly rather than reached for globally. */
export interface CommandContext {
  readonly interaction: ChatInputCommandInteraction;
  /** Logger already tagged with the command name and invoking guild. */
  readonly logger: Logger;
}

export interface AutocompleteContext {
  readonly interaction: AutocompleteInteraction;
  readonly logger: Logger;
}

export interface CommandDefinition {
  /** Builder describing name, description and options. */
  readonly data: AnySlashCommandBuilder;
  readonly category: CommandCategory;
  /** Per-user cooldown in seconds. `0` disables it. */
  readonly cooldownSeconds?: number;
  /** Reject the command outside a guild (most music commands need one). */
  readonly guildOnly?: boolean;
  /** Discord permissions the invoking member must hold. */
  readonly userPermissions?: readonly PermissionResolvable[];
  /** Discord permissions the bot must hold in the channel. */
  readonly botPermissions?: readonly PermissionResolvable[];
  /** Restrict to the configured DJ role. Enforced in Phase 4. */
  readonly djOnly?: boolean;
  /** Hide from `/help` and from production command deployment. */
  readonly devOnly?: boolean;
  execute(context: CommandContext): Promise<void>;
  autocomplete?(context: AutocompleteContext): Promise<void>;
}

/**
 * Identity helper that provides inference and a single place to add future
 * cross-cutting checks.
 *
 * @example
 * export default defineCommand({
 *   data: new SlashCommandBuilder().setName('ping').setDescription('Pong'),
 *   category: 'general',
 *   async execute({ interaction }) { await interaction.reply('Pong'); },
 * });
 */
export function defineCommand(definition: CommandDefinition): CommandDefinition {
  return definition;
}

export { SlashCommandBuilder };

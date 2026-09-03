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

/** Visibility of the deferred acknowledgement Discord shows while a command runs. */
export type DeferralMode = 'public' | 'ephemeral';

/** Applied when a command does not declare {@link CommandDefinition.deferral}. */
export const DEFAULT_DEFERRAL: DeferralMode = 'ephemeral';

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
  /**
   * How the interaction is acknowledged, always *before* any guard runs.
   *
   * Discord invalidates an interaction that is not acknowledged within three
   * seconds (`10062 Unknown interaction`). Guards reach Redis and Postgres,
   * both of which are remote in production, so a command that acknowledges
   * itself is only acknowledged *after* two network round-trips. Deferral
   * moves the acknowledgement in front of all of that.
   *
   * Defaults to `'ephemeral'`, because that is what all but a handful of
   * commands want and because the safe choice must be the one you get for
   * free — the alternative was 31 commands silently racing the deadline.
   *
   * Visibility is fixed at acknowledgement time and cannot be changed later,
   * so a command whose subcommands differ passes a function instead. It is
   * called before any I/O and must stay synchronous and side-effect free;
   * read `interaction.options`, nothing more.
   *
   * A command must never call `deferReply` itself, and must respond with
   * `editReply`/`followUp`.
   */
  readonly deferral?: DeferralMode | ((interaction: ChatInputCommandInteraction) => DeferralMode);
  execute(context: CommandContext): Promise<void>;
  autocomplete?(context: AutocompleteContext): Promise<void>;
}

/**
 * Resolve the acknowledgement mode for one invocation.
 *
 * Kept separate from the dispatcher so the defaulting rule — the thing that
 * decides whether a command races Discord's three-second window — is testable
 * on its own.
 */
export function resolveDeferral(
  command: Pick<CommandDefinition, 'deferral'>,
  interaction: ChatInputCommandInteraction,
): DeferralMode {
  if (typeof command.deferral === 'function') return command.deferral(interaction);
  return command.deferral ?? DEFAULT_DEFERRAL;
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

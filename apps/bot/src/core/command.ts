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

/**
 * Visibility of the acknowledgement, and the rule that picks it.
 *
 * Defined in `@discord-music/shared` rather than here, because the command
 * router in apps/web has to evaluate the same rule and cannot import anything
 * from this app — the command modules pull in discord.js, Lavalink and Prisma.
 */
import type { DeferralSpec } from '@discord-music/shared';

export {
  DEFAULT_DEFERRAL,
  resolveDeferral,
  type DeferralMode,
  type DeferralSpec,
} from '@discord-music/shared';

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
  /** Restrict to the session's DJs (see `music/session-dj.ts`). */
  readonly djOnly?: boolean;
  /**
   * `djOnly`, except over a track the caller queued themselves.
   *
   * `runGuards` cannot enforce this: it has the interaction but not the track
   * the command is about, and "is this mine?" is only answerable once that has
   * been resolved. So the guard stands aside and the command calls
   * `checkDjAuthority` itself, after it knows which track is meant. Anything
   * carrying this flag MUST perform that check.
   */
  readonly ownTrackExempt?: boolean;
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
  readonly deferral?: DeferralSpec;
  execute(context: CommandContext): Promise<void>;
  autocomplete?(context: AutocompleteContext): Promise<void>;
}

/**
 * The invoked subcommand, or null when the command has none.
 *
 * The one thing `resolveDeferral` needs off an interaction, pulled out so the
 * rule itself stays a pure function of two plain values — which is what lets
 * the router evaluate it from raw JSON.
 */
export function subcommandOf(interaction: ChatInputCommandInteraction): string | null {
  return interaction.options.getSubcommand(false);
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

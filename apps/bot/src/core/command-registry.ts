/**
 * Command registry.
 *
 * Discovers `src/commands/<category>/<name>.ts` at startup, validates each
 * module's default export, and indexes commands by name for O(1) dispatch.
 *
 * Loading is filesystem-driven so adding a command is a single new file with no
 * central list to update.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

import { ConfigurationError } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';
import { COMMAND_CATEGORIES, type CommandCategory, type CommandDefinition } from './command.js';

const logger = getLogger('command-registry');

/**
 * Structural check — a command module could export anything, so every field is
 * verified before the value is trusted as a `CommandDefinition`.
 *
 * The candidate is treated as `Record<string, unknown>` rather than a
 * `Partial<CommandDefinition>`: asserting the target shape up front would let
 * the compiler assume properties that have not been checked yet.
 */
function isCommandDefinition(value: unknown): value is CommandDefinition {
  if (typeof value !== 'object' || value === null) return false;

  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  const { data, category, execute } = candidate;

  if (typeof execute !== 'function') return false;
  if (typeof data !== 'object' || data === null) return false;
  if (typeof (data as Record<string, unknown>).name !== 'string') return false;

  return typeof category === 'string' && COMMAND_CATEGORIES.includes(category as CommandCategory);
}

export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>();

  /** Number of registered commands. */
  get size(): number {
    return this.#commands.size;
  }

  get(name: string): CommandDefinition | undefined {
    return this.#commands.get(name);
  }

  values(): readonly CommandDefinition[] {
    return [...this.#commands.values()];
  }

  /**
   * Register one command.
   *
   * @throws {ConfigurationError} If the name collides with an existing command —
   *   a silent overwrite would make one command permanently unreachable.
   */
  register(command: CommandDefinition): void {
    const { name } = command.data;
    if (this.#commands.has(name)) {
      throw new ConfigurationError(
        `Duplicate command name "${name}". Command names must be unique across all categories.`,
      );
    }
    this.#commands.set(name, command);
  }

  /** JSON payloads for the Discord REST command-deployment endpoint. */
  toDeploymentPayload(
    options: { readonly includeDevOnly?: boolean } = {},
  ): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    const { includeDevOnly = false } = options;
    return this.values()
      .filter((command) => includeDevOnly || command.devOnly !== true)
      .map((command) => command.data.toJSON());
  }

  /**
   * Recursively load every command module under `directory`.
   *
   * A file that fails to load is logged and skipped: one broken command must
   * not prevent the bot from starting.
   *
   * @returns The number of commands successfully registered.
   */
  async loadFrom(directory: string): Promise<number> {
    const files = await collectModuleFiles(directory);
    let loaded = 0;

    for (const file of files) {
      try {
        const module: unknown = await import(pathToFileURL(file).href);
        const exported = (module as { default?: unknown }).default;

        if (!isCommandDefinition(exported)) {
          logger.warn({ file }, 'Skipping file: default export is not a valid command definition');
          continue;
        }

        this.register(exported);
        loaded += 1;
        logger.debug(
          { command: exported.data.name, category: exported.category },
          'Command loaded',
        );
      } catch (error) {
        logger.error({ err: error, file }, 'Failed to load command');
      }
    }

    logger.info({ loaded, discovered: files.length }, 'Command loading complete');
    return loaded;
  }
}

/**
 * Collect loadable module files under `directory`, recursively.
 *
 * Accepts `.ts` (tsx/dev) and `.js` (bundled/production) and ignores tests,
 * declaration files and anything prefixed with `_`.
 */
export async function collectModuleFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A missing directory is not fatal — a category may simply have no commands yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ directory }, 'Directory does not exist; nothing to load');
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectModuleFiles(fullPath)));
      continue;
    }

    if (isLoadableModule(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

export function isLoadableModule(fileName: string): boolean {
  if (fileName.startsWith('_') || fileName.startsWith('.')) return false;
  if (fileName.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/u.test(fileName)) return false;
  return /\.[cm]?[jt]s$/u.test(fileName);
}

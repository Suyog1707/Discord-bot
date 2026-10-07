import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ApplicationCommandOptionType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CommandRegistry, isLoadableModule } from './command-registry.js';
import { resolveDeferral, type CommandDefinition } from './command.js';

// Load every real command, not a manually maintained subset. This checks the
// deployment/deferral contract; service tests separately exercise execution.
const root = new URL('../commands/', import.meta.url);
const commands: CommandDefinition[] = [];
for (const category of await readdir(fileURLToPath(root), { withFileTypes: true })) {
  if (!category.isDirectory()) continue;
  const directory = new URL(`${category.name}/`, root);
  for (const file of await readdir(fileURLToPath(directory))) {
    if (!isLoadableModule(file)) continue;
    const module = (await import(new URL(file, directory).href)) as { default: CommandDefinition };
    commands.push(module.default);
  }
}

describe('complete command deployment contract', () => {
  it('loads a nonempty catalog with unique names', () => {
    expect(commands.length).toBeGreaterThan(30);
    const registry = new CommandRegistry();
    for (const command of commands) registry.register(command);
    expect(registry.size).toBe(commands.length);
    expect(registry.toDeploymentPayload()).toHaveLength(commands.length);
  });
  it.each(commands.map((command) => [command.data.name, command] as const))(
    '/%s has a valid payload and deferral for every subcommand',
    (_name, command) => {
      const payload = command.data.toJSON();
      expect(payload.description.length).toBeGreaterThan(0);
      expect(typeof command.execute).toBe('function');
      const subcommands = (payload.options ?? []).flatMap((option) =>
        option.type === ApplicationCommandOptionType.Subcommand
          ? [option.name]
          : option.type === ApplicationCommandOptionType.SubcommandGroup
            ? (option.options ?? []).map((child) => child.name)
            : [],
      );
      for (const subcommand of subcommands.length === 0 ? [null] : subcommands) {
        expect(['public', 'ephemeral']).toContain(resolveDeferral(command.deferral, subcommand));
      }
    },
  );
});

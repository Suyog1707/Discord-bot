import { ConfigurationError } from '@discord-music/shared';
import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { defineCommand } from './command.js';
import { CommandRegistry, isLoadableModule } from './command-registry.js';

function makeCommand(name: string, devOnly = false) {
  return defineCommand({
    data: new SlashCommandBuilder().setName(name).setDescription(`${name} description`),
    category: 'general',
    devOnly,
    execute: async () => {
      await Promise.resolve();
    },
  });
}

describe('CommandRegistry', () => {
  it('registers and retrieves commands by name', () => {
    const registry = new CommandRegistry();
    const ping = makeCommand('ping');

    registry.register(ping);

    expect(registry.size).toBe(1);
    expect(registry.get('ping')).toBe(ping);
    expect(registry.get('nope')).toBeUndefined();
  });

  it('rejects duplicate command names rather than silently overwriting', () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand('play'));

    expect(() => {
      registry.register(makeCommand('play'));
    }).toThrow(ConfigurationError);
  });

  it('builds a deployment payload, excluding dev-only commands by default', () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand('ping'));
    registry.register(makeCommand('debug', true));

    expect(registry.toDeploymentPayload().map((c) => c.name)).toEqual(['ping']);
    expect(
      registry
        .toDeploymentPayload({ includeDevOnly: true })
        .map((c) => c.name)
        .sort(),
    ).toEqual(['debug', 'ping']);
  });

  it('returns zero when loading a directory that does not exist', async () => {
    const registry = new CommandRegistry();
    await expect(registry.loadFrom('/nonexistent/commands')).resolves.toBe(0);
  });
});

describe('isLoadableModule', () => {
  it.each(['ping.ts', 'play.js', 'skip.mjs'])('accepts %s', (name) => {
    expect(isLoadableModule(name)).toBe(true);
  });

  it.each(['_helper.ts', '.hidden.ts', 'types.d.ts', 'ping.test.ts', 'ping.spec.ts', 'README.md'])(
    'rejects %s',
    (name) => {
      expect(isLoadableModule(name)).toBe(false);
    },
  );
});

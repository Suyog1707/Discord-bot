import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { resolveDeferral } from './command.js';

/** Only `options.getSubcommand` is ever read while resolving deferral. */
function interactionWith(subcommand: string): ChatInputCommandInteraction {
  return {
    options: { getSubcommand: () => subcommand },
  } as unknown as ChatInputCommandInteraction;
}

describe('resolveDeferral', () => {
  /**
   * The regression this defaulting exists for: 31 commands acknowledged
   * themselves only after the guards had been to Redis and Postgres, and lost
   * the race often enough to surface as `10062 Unknown interaction`.
   */
  it('defers ephemerally when a command declares nothing', () => {
    expect(resolveDeferral({}, interactionWith('any'))).toBe('ephemeral');
  });

  it('honours an explicit mode', () => {
    expect(resolveDeferral({ deferral: 'public' }, interactionWith('any'))).toBe('public');
    expect(resolveDeferral({ deferral: 'ephemeral' }, interactionWith('any'))).toBe('ephemeral');
  });

  it('lets a command choose per subcommand', () => {
    const command = {
      deferral: (interaction: ChatInputCommandInteraction) =>
        interaction.options.getSubcommand() === 'play'
          ? ('public' as const)
          : ('ephemeral' as const),
    };

    expect(resolveDeferral(command, interactionWith('play'))).toBe('public');
    expect(resolveDeferral(command, interactionWith('list'))).toBe('ephemeral');
  });
});

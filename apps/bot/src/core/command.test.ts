import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import favorite from '../commands/music/favorite.js';
import play from '../commands/music/play.js';
import playlist from '../commands/music/playlist.js';
import queue from '../commands/queue/queue.js';

import { resolveDeferral, subcommandOf } from './command.js';

/** Only `options.getSubcommand` is ever read while resolving deferral. */
function interactionWith(subcommand: string | null): ChatInputCommandInteraction {
  return {
    options: { getSubcommand: () => subcommand },
  } as unknown as ChatInputCommandInteraction;
}

describe('subcommandOf', () => {
  it('reads the invoked subcommand', () => {
    expect(subcommandOf(interactionWith('play'))).toBe('play');
  });

  it('is null for a command with no subcommands', () => {
    // `getSubcommand(false)` returns null rather than throwing, which is the
    // whole reason this wrapper passes `false`.
    expect(subcommandOf(interactionWith(null))).toBeNull();
  });
});

/**
 * The rule itself is tested in `@discord-music/shared`. What matters here is
 * that the *declarations* on the real commands still say what they mean —
 * these are the ones a reader would notice were wrong, and the router now
 * reads the same values out of a published manifest, so a mistake here shows
 * up as a reply appearing in the wrong place for everybody.
 */
describe('what the real commands declare', () => {
  it('announces a track to the channel', () => {
    expect(resolveDeferral(play.deferral, null)).toBe('public');
  });

  it('keeps personal bookkeeping private', () => {
    // 30 of 35 commands declare nothing at all and land here.
    expect(resolveDeferral(queue.deferral, null)).toBe('ephemeral');
  });

  it('splits by subcommand where one fills the channel and the rest do not', () => {
    expect(resolveDeferral(favorite.deferral, 'play')).toBe('public');
    expect(resolveDeferral(favorite.deferral, 'list')).toBe('ephemeral');

    expect(resolveDeferral(playlist.deferral, 'play')).toBe('public');
    expect(resolveDeferral(playlist.deferral, 'shuffle')).toBe('public');
    expect(resolveDeferral(playlist.deferral, 'list')).toBe('ephemeral');
  });
});

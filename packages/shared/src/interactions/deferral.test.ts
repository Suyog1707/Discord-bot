import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEFERRAL,
  decodeDeferralManifest,
  resolveDeferral,
  type DeferralSpec,
} from './deferral.js';

const bySubcommand: DeferralSpec = {
  bySubcommand: { play: 'public', shuffle: 'public' },
  otherwise: 'ephemeral',
};

describe('resolveDeferral', () => {
  it('defaults to ephemeral when a command declares nothing', () => {
    // The safe choice has to be the one you get for free.
    expect(resolveDeferral(undefined, null)).toBe(DEFAULT_DEFERRAL);
    expect(DEFAULT_DEFERRAL).toBe('ephemeral');
  });

  it('applies one mode to the whole command', () => {
    expect(resolveDeferral('public', null)).toBe('public');
    expect(resolveDeferral('public', 'anything')).toBe('public');
  });

  it('picks the mode for the invoked subcommand', () => {
    expect(resolveDeferral(bySubcommand, 'play')).toBe('public');
    expect(resolveDeferral(bySubcommand, 'shuffle')).toBe('public');
    expect(resolveDeferral(bySubcommand, 'list')).toBe('ephemeral');
  });

  it('falls back when there is no subcommand to match', () => {
    expect(resolveDeferral(bySubcommand, null)).toBe('ephemeral');
  });

  it('does not reach up the prototype chain', () => {
    // A subcommand named `toString` or `__proto__` would otherwise resolve to
    // something inherited and fail the enum check somewhere confusing.
    expect(resolveDeferral(bySubcommand, '__proto__')).toBe('ephemeral');
    expect(resolveDeferral(bySubcommand, 'toString')).toBe('ephemeral');
    expect(resolveDeferral(bySubcommand, 'constructor')).toBe('ephemeral');
  });
});

describe('decodeDeferralManifest', () => {
  it('round trips both shapes', () => {
    const manifest = { play: 'public', queue: 'ephemeral', playlist: bySubcommand };

    expect(decodeDeferralManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it('rejects an unknown mode rather than half-applying it', () => {
    expect(decodeDeferralManifest(JSON.stringify({ play: 'loud' }))).toBeNull();
  });

  it('rejects malformed JSON rather than throwing', () => {
    expect(decodeDeferralManifest('{')).toBeNull();
  });
});

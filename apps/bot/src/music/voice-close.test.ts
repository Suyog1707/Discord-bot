import { describe, expect, it } from 'vitest';

import {
  claimReconnect,
  decideVoiceClose,
  expiredReconnects,
  releaseReconnect,
  type ReconnectBudget,
} from './voice-close.js';

describe('decideVoiceClose', () => {
  /** The one that took a guild silent overnight: session killed, bot left in the channel. */
  it('rejoins after "session is no longer valid" (4006)', () => {
    expect(decideVoiceClose(4006)).toBe('reconnect');
  });

  it.each([1006, 4009, 4015])('rejoins after a recoverable close (%i)', (code) => {
    expect(decideVoiceClose(code)).toBe('reconnect');
  });

  /**
   * Kicked, channel deleted, or the voice server moved. Discord sends a voice
   * state update for it and `voice-state-update.ts` tears the player down;
   * rejoining here would race that.
   */
  it('leaves 4014 to the voice-state handler', () => {
    expect(decideVoiceClose(4014)).toBe('ignore');
  });

  it.each([4004, 4011, 4016])('does not rejoin on a fault a rejoin cannot fix (%i)', (code) => {
    expect(decideVoiceClose(code)).toBe('ignore');
  });
});

describe('claimReconnect', () => {
  const limits = { maxAttempts: 3, windowMs: 60_000, stabilityMs: 30_000 };

  /** A budget mid-window, with whatever the test cares about overridden. */
  function budget(overrides: Partial<ReconnectBudget> = {}): ReconnectBudget {
    return { startedAt: 1_000, attempts: 1, inFlight: false, recoveredAt: null, ...overrides };
  }

  it('claims the first attempt', () => {
    const claim = claimReconnect(undefined, 1_000, limits);

    expect(claim.decision).toBe('claimed');
    expect(claim).toHaveProperty('next', {
      startedAt: 1_000,
      attempts: 1,
      inFlight: true,
      recoveredAt: null,
    });
  });

  /** A close arriving mid-rebuild is the teardown's own echo, not a new fault. */
  it('drops a close that lands while a rebuild is running', () => {
    const busy = budget({ inFlight: true });

    expect(claimReconnect(busy, 2_000, limits).decision).toBe('busy');
  });

  it('counts attempts up to the limit', () => {
    const claim = claimReconnect(budget({ attempts: 2 }), 2_000, limits);

    expect(claim).toEqual({
      decision: 'claimed',
      next: { startedAt: 1_000, attempts: 3, inFlight: true, recoveredAt: null },
    });
  });

  /** The runaway case: rejoining is not working, so stop rather than loop. */
  it('gives up once the budget inside the window is spent', () => {
    const spent = budget({ attempts: 3 });

    expect(claimReconnect(spent, 2_000, limits).decision).toBe('exhausted');
  });

  it('starts a fresh window once the old one has passed', () => {
    const spent = budget({ attempts: 3 });
    const claim = claimReconnect(spent, 1_000 + limits.windowMs + 1, limits);

    expect(claim.decision).toBe('claimed');
    expect(claim).toHaveProperty('next.attempts', 1);
  });

  /**
   * The regression: a flaky network that drops every few minutes recovers
   * cleanly each time, and used to spend its whole budget doing so — three
   * good reconnects inside one window tore down a working session.
   */
  it('starts over when the last rebuild held for a while', () => {
    const spent = budget({ attempts: 3, recoveredAt: 5_000 });

    const claim = claimReconnect(spent, 5_000 + limits.stabilityMs, limits);

    expect(claim.decision).toBe('claimed');
    expect(claim).toHaveProperty('next.attempts', 1);
  });

  /** A socket that dies seconds after coming back is the loop the budget is for. */
  it('keeps counting when a rebuild drops again straight away', () => {
    const spent = budget({ attempts: 3, recoveredAt: 5_000 });

    expect(claimReconnect(spent, 5_000 + limits.stabilityMs - 1, limits).decision).toBe(
      'exhausted',
    );
  });

  it('carries the recovery stamp through an attempt that is still counted', () => {
    const claim = claimReconnect(budget({ attempts: 1, recoveredAt: 900 }), 2_000, limits);

    expect(claim).toHaveProperty('next.recoveredAt', 900);
  });
});

describe('releaseReconnect', () => {
  it('stamps a recovery rather than forgetting the budget', () => {
    const released = releaseReconnect(
      { startedAt: 1_000, attempts: 2, inFlight: true, recoveredAt: null },
      'recovered',
      9_000,
    );

    expect(released).toEqual({
      startedAt: 1_000,
      attempts: 2,
      inFlight: false,
      recoveredAt: 9_000,
    });
  });

  /** A failure must not look like a session that held; it has to keep counting. */
  it('clears the stamp when a rebuild fails', () => {
    const released = releaseReconnect(
      { startedAt: 1_000, attempts: 2, inFlight: true, recoveredAt: 500 },
      'failed',
      9_000,
    );

    expect(released).toMatchObject({ inFlight: false, recoveredAt: null });
  });

  it('has nothing to hand back when the entry is already gone', () => {
    expect(releaseReconnect(undefined, 'recovered', 9_000)).toBeUndefined();
  });
});

describe('expiredReconnects', () => {
  /** Budgets were only ever written; a long-lived process leaked one per guild. */
  it('names guilds whose window has closed', () => {
    const entries: [string, ReconnectBudget][] = [
      ['old', { startedAt: 1_000, attempts: 1, inFlight: false, recoveredAt: null }],
      ['recent', { startedAt: 55_000, attempts: 1, inFlight: false, recoveredAt: null }],
    ];

    expect(expiredReconnects(entries, 62_000, 60_000)).toEqual(['old']);
  });

  /** A running rebuild still needs its entry when it finishes. */
  it('never sweeps a rebuild that is in flight', () => {
    const entries: [string, ReconnectBudget][] = [
      ['busy', { startedAt: 1_000, attempts: 1, inFlight: true, recoveredAt: null }],
    ];

    expect(expiredReconnects(entries, 999_000, 60_000)).toEqual([]);
  });

  it('returns nothing for an empty map', () => {
    expect(expiredReconnects(new Map(), 1_000, 60_000)).toEqual([]);
  });
});

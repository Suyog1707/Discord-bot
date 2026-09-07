import { describe, expect, it } from 'vitest';

import { claimReconnect, decideVoiceClose } from './voice-close.js';

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
  const limits = { maxAttempts: 3, windowMs: 60_000 };

  it('claims the first attempt', () => {
    const claim = claimReconnect(undefined, 1_000, limits);

    expect(claim.decision).toBe('claimed');
    expect(claim).toHaveProperty('next', { startedAt: 1_000, attempts: 1, inFlight: true });
  });

  /** A close arriving mid-rebuild is the teardown's own echo, not a new fault. */
  it('drops a close that lands while a rebuild is running', () => {
    const busy = { startedAt: 1_000, attempts: 1, inFlight: true };

    expect(claimReconnect(busy, 2_000, limits).decision).toBe('busy');
  });

  it('counts attempts up to the limit', () => {
    const claim = claimReconnect({ startedAt: 1_000, attempts: 2, inFlight: false }, 2_000, limits);

    expect(claim).toEqual({
      decision: 'claimed',
      next: { startedAt: 1_000, attempts: 3, inFlight: true },
    });
  });

  /** The runaway case: rejoining is not working, so stop rather than loop. */
  it('gives up once the budget inside the window is spent', () => {
    const spent = { startedAt: 1_000, attempts: 3, inFlight: false };

    expect(claimReconnect(spent, 2_000, limits).decision).toBe('exhausted');
  });

  it('starts a fresh window once the old one has passed', () => {
    const spent = { startedAt: 1_000, attempts: 3, inFlight: false };
    const claim = claimReconnect(spent, 1_000 + limits.windowMs + 1, limits);

    expect(claim.decision).toBe('claimed');
    expect(claim).toHaveProperty('next.attempts', 1);
  });
});

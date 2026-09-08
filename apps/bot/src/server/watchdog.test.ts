import { describe, expect, it } from 'vitest';

import { HEALTHY, observeHealth, type WatchdogState } from './watchdog.js';

const NOW = 1_000_000;
const EXIT_AFTER_MS = 120_000;

/** The state a bot is left in after `downForMs` of continuous disconnection. */
function down(downForMs: number): WatchdogState {
  return { downSince: NOW - downForMs };
}

describe('observeHealth', () => {
  it('stays healthy while the gateway is up', () => {
    const verdict = observeHealth(HEALTHY, {
      gatewayUp: true,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });

    expect(verdict).toEqual({ kind: 'ok', next: HEALTHY });
  });

  it('starts the clock rather than acting on the first observation', () => {
    const verdict = observeHealth(HEALTHY, {
      gatewayUp: false,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });

    expect(verdict).toEqual({ kind: 'ok', next: { downSince: NOW } });
  });

  it('keeps the original timestamp across later observations', () => {
    const verdict = observeHealth(down(60_000), {
      gatewayUp: false,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });

    // Not `now` — otherwise the deadline would reset on every check and never
    // be reached.
    expect(verdict).toEqual({ kind: 'ok', next: { downSince: NOW - 60_000 } });
  });

  it('exits once the gateway has been down longer than the threshold', () => {
    const verdict = observeHealth(down(EXIT_AFTER_MS + 1), {
      gatewayUp: false,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });

    expect(verdict).toEqual({ kind: 'exit', downForMs: EXIT_AFTER_MS + 1 });
  });

  it('exits exactly at the threshold', () => {
    const verdict = observeHealth(down(EXIT_AFTER_MS), {
      gatewayUp: false,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });

    expect(verdict.kind).toBe('exit');
  });

  it('forgets a past outage as soon as the gateway comes back', () => {
    // discord.js reconnects on its own, and a bot that recovered a second
    // before the deadline must not be restarted by the next brief blip.
    const recovered = observeHealth(down(EXIT_AFTER_MS - 1), {
      gatewayUp: true,
      now: NOW,
      exitAfterMs: EXIT_AFTER_MS,
    });
    expect(recovered).toEqual({ kind: 'ok', next: HEALTHY });

    const blip = observeHealth(recovered.kind === 'ok' ? recovered.next : HEALTHY, {
      gatewayUp: false,
      now: NOW + 1_000,
      exitAfterMs: EXIT_AFTER_MS,
    });
    expect(blip).toEqual({ kind: 'ok', next: { downSince: NOW + 1_000 } });
  });

  it('never exits when the check is disabled', () => {
    const verdict = observeHealth(down(EXIT_AFTER_MS * 10), {
      gatewayUp: false,
      now: NOW,
      exitAfterMs: 0,
    });

    // The state is returned untouched: turning the check back on should not
    // find a deadline that silently passed while it was off.
    expect(verdict).toEqual({ kind: 'ok', next: down(EXIT_AFTER_MS * 10) });
  });
});

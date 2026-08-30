import { describe, expect, it } from 'vitest';

import {
  type AutoplayKind,
  type InterleaveConfig,
  type InterleaveInput,
  DEFAULT_INTERLEAVE,
  planSlots,
} from './interleave.js';

function input(overrides: Partial<InterleaveInput> = {}): InterleaveInput {
  return {
    count: 2,
    recentKinds: [],
    familiarAvailable: 20,
    discoveryAvailable: 20,
    familiarStrong: 0,
    ...overrides,
  };
}

function config(overrides: Partial<InterleaveConfig> = {}): InterleaveConfig {
  return { ...DEFAULT_INTERLEAVE, ...overrides };
}

/** How many familiar tracks separate each pair of discoveries in a plan. */
function runsBetweenDiscoveries(kinds: readonly AutoplayKind[]): readonly number[] {
  const runs: number[] = [];
  let run = 0;
  for (const kind of kinds) {
    if (kind === 'discovery') {
      runs.push(run);
      run = 0;
    } else {
      run += 1;
    }
  }
  return runs;
}

describe('planSlots — cadence', () => {
  it('plays familiar first when the session has not started', () => {
    expect(planSlots(input({ count: 3 }))).toEqual(['familiar', 'familiar', 'discovery']);
  });

  it('places a discovery every third slot with the default run', () => {
    const kinds = planSlots(input({ count: 9 }));

    expect(kinds).toEqual([
      'familiar',
      'familiar',
      'discovery',
      'familiar',
      'familiar',
      'discovery',
      'familiar',
      'familiar',
      'discovery',
    ]);
  });

  it('stretches the run to three when the familiar pool is strong', () => {
    const kinds = planSlots(input({ count: 8, familiarStrong: 6 }));

    expect(runsBetweenDiscoveries(kinds)).toEqual([3, 3]);
  });

  it('keeps the run at the minimum when the pool is thin on strong picks', () => {
    const kinds = planSlots(input({ count: 8, familiarStrong: 5 }));

    expect(runsBetweenDiscoveries(kinds)).toEqual([2, 2]);
  });

  it('honours a custom run configuration', () => {
    const kinds = planSlots(
      input({ count: 6, familiarStrong: 10, config: config({ familiarRunMin: 1 }) }),
    );

    expect(runsBetweenDiscoveries(kinds)).toEqual([3]);
  });
});

// The whole reason cadence lives in the session rather than in the batch:
// autoplay generates two tracks at a time and must not spend a discovery slot
// twice, nor forget that it owes one.
describe('planSlots — continuing a run across batches', () => {
  it('spends the discovery immediately when the run is already complete', () => {
    const kinds = planSlots(input({ count: 2, recentKinds: ['familiar', 'familiar'] }));

    expect(kinds).toEqual(['discovery', 'familiar']);
  });

  it('finishes a partial run before discovering', () => {
    const kinds = planSlots(input({ count: 2, recentKinds: ['familiar', 'discovery'] }));

    expect(kinds).toEqual(['familiar', 'discovery']);
  });

  it('stops counting at the last discovery', () => {
    const kinds = planSlots(
      input({ count: 1, recentKinds: ['familiar', 'discovery', 'familiar', 'familiar'] }),
    );

    expect(kinds).toEqual(['familiar']);
  });

  it('restarts the run right after a discovery', () => {
    const kinds = planSlots(input({ count: 3, recentKinds: ['discovery', 'familiar'] }));

    expect(kinds).toEqual(['familiar', 'familiar', 'discovery']);
  });
});

describe('planSlots — pool availability', () => {
  it('plans discovery only when nothing familiar is available', () => {
    const kinds = planSlots(input({ count: 4, familiarAvailable: 0 }));

    expect(kinds).toEqual(['discovery', 'discovery', 'discovery', 'discovery']);
  });

  it('plans familiar only when discovery is unavailable', () => {
    const kinds = planSlots(input({ count: 4, discoveryAvailable: 0 }));

    expect(kinds).toEqual(['familiar', 'familiar', 'familiar', 'familiar']);
  });

  it('plans familiar only when discovery is switched off', () => {
    const kinds = planSlots(
      input({ count: 4, config: config({ discoveryEnabled: false }), recentKinds: ['familiar'] }),
    );

    expect(kinds).toEqual(['familiar', 'familiar', 'familiar', 'familiar']);
  });

  it('falls back to discovery when the familiar pool runs out mid-plan', () => {
    const kinds = planSlots(input({ count: 4, familiarAvailable: 1 }));

    expect(kinds).toEqual(['familiar', 'discovery', 'discovery', 'discovery']);
  });

  it('never plans two discoveries in a row while familiar tracks remain', () => {
    const kinds = planSlots(
      input({
        count: 10,
        familiarAvailable: 10,
        discoveryAvailable: 10,
        recentKinds: ['familiar'],
      }),
    );

    for (const [index, kind] of kinds.entries()) {
      if (index === 0) continue;
      expect([kind, kinds[index - 1]]).not.toEqual(['discovery', 'discovery']);
    }
  });

  it('returns a shorter plan when both pools are exhausted', () => {
    const kinds = planSlots(input({ count: 5, familiarAvailable: 2, discoveryAvailable: 1 }));

    expect(kinds).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'familiar')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'discovery')).toHaveLength(1);
  });

  it('returns nothing when neither pool has anything', () => {
    expect(planSlots(input({ count: 3, familiarAvailable: 0, discoveryAvailable: 0 }))).toEqual([]);
  });

  it('never plans more slots than were asked for', () => {
    expect(planSlots(input({ count: 0 }))).toEqual([]);
  });
});

describe('planSlots — determinism', () => {
  it('returns the same plan for the same input', () => {
    const request = input({ count: 12, familiarStrong: 8, recentKinds: ['familiar'] });

    expect(planSlots(request)).toEqual(planSlots(request));
  });
});

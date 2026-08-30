import { describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import type { AutoplayGenerator, GeneratedTrack } from './autoplay-planner.js';
import { AutoplayEngine } from './autoplay.js';
import { identityOf, trackKeyOf } from './identity.js';
import type { RecommendationExclusions, TrackSeed } from './recommender.js';
import { AutoplaySessionStore, type SessionEntry } from './session.js';

/** Build a QueuedTrack the way autoplay's own resolver would — see `track()` in recommender.test.ts. */
function queuedTrack(id: string, artist: string, title: string): QueuedTrack {
  return {
    encoded: '',
    identifier: id,
    title,
    author: artist,
    durationMs: 180_000,
    uri: null,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: '0',
    requestedByName: 'Autoplay',
  };
}

function sessionEntryFor(track: QueuedTrack): SessionEntry {
  const identity = identityOf(track.author, track.title);
  return { key: identity.key, identifier: track.identifier, artistKey: identity.artistKey };
}

interface GenerateCall {
  readonly guildId: string;
  readonly seeds: readonly TrackSeed[];
  readonly count: number;
  /** The exclusions the fake derived from the session, as the real planner does. */
  readonly exclusions: RecommendationExclusions;
}

/**
 * A minimal fake standing in for the planner, honouring just enough of the
 * real contract for AutoplayEngine to be exercised honestly: it reads the
 * session store's exclusions itself (that responsibility lives in the
 * generator, not the engine), removes anything excluded before offering
 * candidates, and — like the real reserve step — only serves what the
 * session actually grants.
 */
function makeFakeGenerator(
  session: AutoplaySessionStore,
  supply: (call: GenerateCall) => readonly QueuedTrack[],
): { generator: AutoplayGenerator; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];

  const generate = async (
    guildId: string,
    seeds: readonly TrackSeed[],
    count: number,
  ): Promise<readonly GeneratedTrack[]> => {
    const snapshot = await session.snapshot(guildId);
    const exclusions: RecommendationExclusions = {
      trackKeys: new Set([
        ...snapshot.recentKeys,
        ...snapshot.queuedKeys,
        ...snapshot.reservedKeys,
      ]),
      identifiers: new Set([...snapshot.recentIdentifiers, ...snapshot.queuedIdentifiers]),
    };
    const call: GenerateCall = { guildId, seeds, count, exclusions };
    calls.push(call);

    const offered = supply(call);
    const survivors = offered.filter((candidate) => {
      const key = trackKeyOf(candidate.author, candidate.title);
      if (exclusions.trackKeys.has(key)) return false;
      if (exclusions.identifiers.has(candidate.identifier)) return false;
      return true;
    });

    const keys = survivors.map((candidate) => trackKeyOf(candidate.author, candidate.title));
    const grantedKeys = await session.reserve(guildId, keys);
    return survivors
      .filter((candidate) => grantedKeys.has(trackKeyOf(candidate.author, candidate.title)))
      .slice(0, count)
      .map((track) => ({ track, reservedKey: trackKeyOf(track.author, track.title) }));
  };

  return { generator: { generate }, calls };
}

const seeds: readonly TrackSeed[] = [{ title: 'Seed Song', artist: 'Seed Artist' }];

/** Poll until `check()` is truthy or the attempt budget runs out. */
async function waitUntil(check: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('AutoplayEngine — no duplicate across consecutive takes', () => {
  // The bug this pins: the original engine refilled from the same seeds with
  // no memory of what it had already served, so the deterministic pipeline
  // dutifully handed back the same track. A track that has started playing
  // must be structurally unable to come back on the very next take.
  it('never serves a track again once playback of it has been recorded', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const trackB = queuedTrack('b1', 'Artist B', 'Song B');
    const { generator } = makeFakeGenerator(session, () => [trackA, trackB]);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 2 });

    const first = await engine.take('guild', 2, seeds);
    expect(first.length).toBeGreaterThan(0);

    // Simulate playback actually starting on the first served track.
    await session.recordPlayed('guild', sessionEntryFor(trackA));

    const second = await engine.take('guild', 2, seeds);

    const firstIds = new Set(first.map((entry) => entry.identifier));
    expect(second.some((entry) => entry.identifier === 'a1')).toBe(false);
    for (const entry of second) expect(firstIds.has(entry.identifier)).toBe(false);
  });
});

describe('AutoplayEngine — exclusions passed to generation', () => {
  it('carries both recently-played and freshly-queued tracks as hard exclusions', async () => {
    const session = new AutoplaySessionStore();
    const played = queuedTrack('x1', 'Artist X', 'Song X');
    const queued = queuedTrack('y1', 'Artist Y', 'Song Y');
    const { generator, calls } = makeFakeGenerator(session, () => []);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 2 });

    await session.recordPlayed('guild', sessionEntryFor(played));
    await session.syncQueue('guild', [sessionEntryFor(queued)]);

    await engine.take('guild', 2, seeds);

    const request = calls.at(-1);
    expect(request?.exclusions.trackKeys.has(trackKeyOf(played.author, played.title))).toBe(true);
    expect(request?.exclusions.trackKeys.has(trackKeyOf(queued.author, queued.title))).toBe(true);
  });
});

describe('AutoplayEngine — concurrent take + prefetch coalesce', () => {
  it('invokes the generator exactly once when a take races an in-flight prefetch', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    let invocations = 0;
    let releaseHang: (() => void) | undefined;

    const generator: AutoplayGenerator = {
      generate: (): Promise<readonly GeneratedTrack[]> => {
        invocations += 1;
        return new Promise((resolve) => {
          releaseHang = () => {
            resolve([{ track: trackA, reservedKey: trackKeyOf(trackA.author, trackA.title) }]);
          };
        });
      },
    };

    const engine = new AutoplayEngine(generator, session, { prefetchSize: 1 });

    engine.prefetch('guild', seeds);
    const takePromise = engine.take('guild', 1, seeds);

    await waitUntil(() => releaseHang !== undefined);
    releaseHang?.();
    const served = await takePromise;

    expect(invocations).toBe(1);
    expect(served.map((entry) => entry.identifier)).toEqual(['a1']);
  });
});

describe('AutoplayEngine — buffer serves on matching seeds', () => {
  // The bug this pins: seed identity used to be compared as two
  // differently-sized seed lists as raw strings, which never matched — every
  // buffer was judged stale and the prefetch path silently never served.
  it('serves a matching-seed take from the prefetched buffer without a second generation call', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const trackB = queuedTrack('b1', 'Artist B', 'Song B');
    const trackC = queuedTrack('c1', 'Artist C', 'Song C');
    const { generator, calls } = makeFakeGenerator(session, () => [trackA, trackB, trackC]);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 3 });

    engine.prefetch('guild', seeds);

    let served: readonly QueuedTrack[] = [];
    for (let attempt = 0; attempt < 50 && served.length === 0; attempt += 1) {
      served = await engine.take('guild', 2, seeds);
      if (served.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(served.length).toBeGreaterThan(0);
    expect(calls.length).toBe(1);
  });
});

describe('AutoplayEngine — seed drift invalidates the buffer', () => {
  it('discards a buffer built for a different seed and releases its reservations', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    // Mutable so the S2 generation pass (below) can offer nothing — that way
    // an empty reservation set afterwards can only mean the S1 buffer's
    // reservation was actually released, not re-granted by a new pick.
    let offered: readonly QueuedTrack[] = [trackA];
    const { generator, calls } = makeFakeGenerator(session, () => offered);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 1 });
    const seedS1: readonly TrackSeed[] = [{ title: 'Song S1', artist: 'Artist S1' }];
    const seedS2: readonly TrackSeed[] = [{ title: 'Song S2', artist: 'Artist S2' }];

    engine.prefetch('guild', seedS1);
    await waitUntil(() => calls.length >= 1);
    // Let the refill's own buffer write (after recommend resolves) land.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const reservedKey = trackKeyOf(trackA.author, trackA.title);
    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(true);

    offered = [];
    const drifted = await engine.take('guild', 1, seedS2);

    // The S1 buffer was discarded rather than served for an unrelated seed,
    // so a fresh generation runs for S2.
    expect(calls.length).toBe(2);
    expect(drifted).toEqual([]);
    // And the discarded buffer's reservation was released, not leaked — with
    // nothing offered for S2, an empty set here can only mean `clear()` freed it.
    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(false);
  });

  it('releases buffered reservations directly via clear()', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const { generator, calls } = makeFakeGenerator(session, () => [trackA]);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 1 });

    engine.prefetch('guild', seeds);
    await waitUntil(() => calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const reservedKey = trackKeyOf(trackA.author, trackA.title);
    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(true);

    engine.clear('guild');

    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(false);
  });
});

describe('AutoplayEngine — evict', () => {
  it('drops a disliked song from the buffer and releases its reservation, keeping the rest', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const trackB = queuedTrack('b1', 'Artist B', 'Song B');
    const { generator, calls } = makeFakeGenerator(session, () => [trackA, trackB]);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 2 });

    engine.prefetch('guild', seeds);
    await waitUntil(() => calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const keyA = trackKeyOf(trackA.author, trackA.title);
    expect(engine.evict('guild', new Set([keyA]))).toBe(1);
    expect((await session.snapshot('guild')).reservedKeys.has(keyA)).toBe(false);

    const served = await engine.take('guild', 2, seeds);
    expect(served.map((entry) => entry.identifier)).toEqual(['b1']);
  });
});

describe('AutoplayEngine — generation failure', () => {
  it('resolves to an empty array rather than throwing when the generator rejects', async () => {
    const session = new AutoplaySessionStore();
    const generator: AutoplayGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('generate blew up')),
    };
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 2 });

    const served = await engine.take('guild', 2, seeds);

    expect(served).toEqual([]);
  });
});

describe('AutoplayEngine — recordOutcome wiring', () => {
  it('records exactly as many "recommended" outcomes as tracks served', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const trackB = queuedTrack('b1', 'Artist B', 'Song B');
    const { generator } = makeFakeGenerator(session, () => [trackA, trackB]);
    const engine = new AutoplayEngine(generator, session, { prefetchSize: 2 });

    const served = await engine.take('guild', 2, seeds);

    // recordOutcome is fire-and-forget from #generate; give its microtask a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const snapshot = await session.snapshot('guild');
    expect(snapshot.outcomes.recommended).toBe(served.length);
  });
});

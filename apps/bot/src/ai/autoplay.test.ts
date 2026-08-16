import { describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import { AutoplayEngine } from './autoplay.js';
import { identityOf, trackKeyOf } from './identity.js';
import type { MusicOrchestrator } from './orchestrator.js';
import type { TrackSeed } from './recommender.js';
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

type RecommendRequest = Parameters<MusicOrchestrator['recommend']>[0];
type RecommendResult = Awaited<ReturnType<MusicOrchestrator['recommend']>>;

/**
 * A minimal fake standing in for the whole recommendation stack, honouring
 * just enough of the real `RecommendationService` contract for AutoplayEngine
 * to be exercised honestly: it removes anything in `request.exclusions`
 * before offering candidates, and — like the real reserve step — only serves
 * what the injected `reserve` callback actually grants.
 */
function makeFakeOrchestrator(
  supply: (request: RecommendRequest) => readonly QueuedTrack[],
): { orchestrator: MusicOrchestrator; calls: RecommendRequest[] } {
  const calls: RecommendRequest[] = [];

  const recommend = async (request: RecommendRequest): Promise<RecommendResult> => {
    calls.push(request);
    const offered = supply(request);
    const exclusions = request.exclusions;
    const survivors = offered.filter((candidate) => {
      const key = trackKeyOf(candidate.author, candidate.title);
      if (exclusions?.trackKeys.has(key) === true) return false;
      if (exclusions?.identifiers.has(candidate.identifier) === true) return false;
      return true;
    });

    let granted = survivors;
    if (request.reserve !== undefined) {
      const keys = survivors.map((candidate) => trackKeyOf(candidate.author, candidate.title));
      const grantedKeys = await request.reserve(keys);
      granted = survivors.filter((candidate) =>
        grantedKeys.has(trackKeyOf(candidate.author, candidate.title)),
      );
    }

    const resolved = granted.map((candidate) => ({
      track: candidate,
      trackKey: trackKeyOf(candidate.author, candidate.title),
    }));

    return {
      tracks: resolved.map((entry) => entry.track),
      resolved,
      blockedCount: offered.length - survivors.length,
      strategies: ['fake'],
      timings: {},
    };
  };

  return { orchestrator: { recommend } as unknown as MusicOrchestrator, calls };
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
    const { orchestrator } = makeFakeOrchestrator(() => [trackA, trackB]);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 2 });

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
    const { orchestrator, calls } = makeFakeOrchestrator(() => []);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 2 });

    await session.recordPlayed('guild', sessionEntryFor(played));
    await session.syncQueue('guild', [sessionEntryFor(queued)]);

    await engine.take('guild', 2, seeds);

    const request = calls.at(-1);
    expect(request?.exclusions?.trackKeys.has(trackKeyOf(played.author, played.title))).toBe(true);
    expect(request?.exclusions?.trackKeys.has(trackKeyOf(queued.author, queued.title))).toBe(true);
  });
});

describe('AutoplayEngine — concurrent take + prefetch coalesce', () => {
  it('invokes the recommender exactly once when a take races an in-flight prefetch', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    let invocations = 0;
    let releaseHang: (() => void) | undefined;

    const orchestrator = {
      recommend: (): Promise<RecommendResult> => {
        invocations += 1;
        return new Promise((resolve) => {
          releaseHang = () => {
            resolve({
              tracks: [trackA],
              resolved: [{ track: trackA, trackKey: trackKeyOf(trackA.author, trackA.title) }],
              blockedCount: 0,
              strategies: ['fake'],
              timings: {},
            });
          };
        });
      },
    } as unknown as MusicOrchestrator;

    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 1 });

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
    const { orchestrator, calls } = makeFakeOrchestrator(() => [trackA, trackB, trackC]);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 3 });

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
    const { orchestrator, calls } = makeFakeOrchestrator(() => offered);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 1 });
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
    const { orchestrator, calls } = makeFakeOrchestrator(() => [trackA]);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 1 });

    engine.prefetch('guild', seeds);
    await waitUntil(() => calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const reservedKey = trackKeyOf(trackA.author, trackA.title);
    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(true);

    engine.clear('guild');

    expect((await session.snapshot('guild')).reservedKeys.has(reservedKey)).toBe(false);
  });
});

describe('AutoplayEngine — generation failure', () => {
  it('resolves to an empty array rather than throwing when the recommender rejects', async () => {
    const session = new AutoplaySessionStore();
    const orchestrator = {
      recommend: vi.fn().mockRejectedValue(new Error('recommend blew up')),
    } as unknown as MusicOrchestrator;
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 2 });

    const served = await engine.take('guild', 2, seeds);

    expect(served).toEqual([]);
  });
});

describe('AutoplayEngine — recordOutcome wiring', () => {
  it('records exactly as many "recommended" outcomes as tracks served', async () => {
    const session = new AutoplaySessionStore();
    const trackA = queuedTrack('a1', 'Artist A', 'Song A');
    const trackB = queuedTrack('b1', 'Artist B', 'Song B');
    const { orchestrator } = makeFakeOrchestrator(() => [trackA, trackB]);
    const engine = new AutoplayEngine(orchestrator, session, { prefetchSize: 2 });

    const served = await engine.take('guild', 2, seeds);

    // recordOutcome is fire-and-forget from #generate; give its microtask a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const snapshot = await session.snapshot('guild');
    expect(snapshot.outcomes.recommended).toBe(served.length);
  });
});

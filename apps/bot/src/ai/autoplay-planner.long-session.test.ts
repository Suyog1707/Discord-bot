/**
 * The planner over TIME.
 *
 * `autoplay-planner.test.ts` asks "given these pools, what does one batch look
 * like?". This file asks the question that actually produced "Queue ended": what
 * happens on the fortieth batch, when every song the room knows has already been
 * played once and the recent ring is the only thing standing between the
 * listener and silence. Everything here therefore runs on a controllable clock —
 * the session store's `now` and `Date.now()` are pinned to the same fake so the
 * repeat cooldown can be reasoned about in simulated minutes rather than
 * wall-clock luck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import { AutoplayPlanner, type DislikeSource, type PlannerResolvers } from './autoplay-planner.js';
import type { FamiliarCandidate, FamiliarSource } from './familiar-scoring.js';
import type { FamiliarPoolService } from './familiar.js';
import { identityOf } from './identity.js';
import type {
  RankedCandidates,
  RecommendationRequest,
  RecommendationService,
  TrackSeed,
} from './recommender.js';
import type { Candidate, ScoredCandidate } from './scoring.js';
import { AutoplaySessionStore, type SessionEntry } from './session.js';
import { roomRefOf } from './room.js';
import {
  EMPTY_RECENT_CONTEXT,
  EMPTY_TASTE_PROFILE,
  type RecentContext,
  type TasteProfile,
  type UserTasteService,
} from './taste.js';

/** Autoplay is scoped to a voice channel now; one room stands in for the old guild. */
const ROOM = roomRefOf('guild', 'vc-1');

/* ---------------------------------------------------------------- the clock */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A pop song. The unit the whole simulation is measured in. */
const TRACK_MS = 4 * MINUTE;
const START = Date.parse('2026-03-01T18:00:00.000Z');

let clock = START;

/**
 * Move simulated time forward. `vi.setSystemTime` keeps `Date.now()` — which
 * the planner reads for its cooldown arithmetic — in lockstep with the store's
 * injected clock; without that the two disagree and every cooldown assertion
 * becomes a coin toss.
 */
function advance(ms: number): void {
  clock += ms;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  clock = START;
  // Only Date: the store and the planner are timer-free, and faking
  // setTimeout would only give the async plumbing a chance to deadlock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ fixtures */

function familiar(
  artist: string,
  title: string,
  sources: readonly FamiliarSource[],
  overrides: Partial<FamiliarCandidate> = {},
): FamiliarCandidate {
  return {
    title,
    artist,
    durationMs: 200_000,
    uri: null,
    identifier: `id:${artist}:${title}`,
    source: 'spotify',
    artworkUrl: null,
    sources: new Set(sources),
    plays: 0,
    userPlays: 0,
    completions: 0,
    earlySkips: 0,
    lastPlayedAt: START - 48 * HOUR,
    playlistRelevance: 0,
    listenerCount: 1,
    ...overrides,
  };
}

function discovery(artist: string, title: string, match = 0.8): Candidate {
  return { title, artist, origin: 'similar-track', match };
}

function scored(candidate: Candidate, final: number): ScoredCandidate {
  const identity = identityOf(candidate.artist, candidate.title);
  return {
    candidate,
    artistKey: identity.artistKey,
    trackKey: identity.key,
    breakdown: {
      similarity: final,
      tagAffinity: 0.5,
      userAffinity: 0.5,
      moodFit: 0.5,
      novelty: 0.7,
      recentBehaviour: 0.4,
      recencyPenalty: 0,
      artistPenalty: 0,
      skipPenalty: 0,
      languagePenalty: 0,
      final,
    },
  };
}

function playable(
  artist: string,
  title: string,
  identifier = `res:${artist}:${title}`,
): QueuedTrack {
  return {
    encoded: '',
    identifier,
    title,
    author: artist,
    durationMs: 200_000,
    uri: null,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: '0',
    requestedByName: 'Autoplay',
  };
}

function entryOf(
  track: Pick<QueuedTrack, 'author' | 'title' | 'identifier'>,
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  const identity = identityOf(track.author, track.title);
  return {
    key: identity.key,
    identifier: track.identifier,
    artistKey: identity.artistKey,
    ...extra,
  };
}

interface Harness {
  readonly planner: AutoplayPlanner;
  readonly session: AutoplaySessionStore;
  readonly rank: ReturnType<typeof vi.fn>;
  readonly resolveKnown: ReturnType<typeof vi.fn>;
  readonly resolveDiscovery: ReturnType<typeof vi.fn>;
}

/**
 * The planner with every collaborator faked at its seam. Resolvers default to
 * "every song plays", so a test that wants a failure overrides them.
 */
function harness(options: {
  readonly pool?: readonly FamiliarCandidate[];
  readonly discoveries?: readonly ScoredCandidate[];
  /**
   * A discovery supply that answers each `rank` call afresh, the way a real
   * Last.fm neighbourhood does as the seeds rotate. Wins over `discoveries`.
   */
  readonly discoverySupply?: (request: RecommendationRequest) => readonly ScoredCandidate[];
  readonly recent?: RecentContext;
  readonly profile?: TasteProfile;
  readonly resolvers?: Partial<PlannerResolvers>;
  readonly config?: ConstructorParameters<typeof AutoplayPlanner>[0]['config'];
  readonly session?: AutoplaySessionStore;
  readonly dislikes?: DislikeSource;
}): Harness {
  const session = options.session ?? new AutoplaySessionStore({ now: () => clock });

  const taste = {
    profile: vi.fn(() => Promise.resolve(options.profile ?? EMPTY_TASTE_PROFILE)),
    recentContext: vi.fn(() => Promise.resolve(options.recent ?? EMPTY_RECENT_CONTEXT)),
  } as unknown as UserTasteService;

  const familiarService = {
    pool: vi.fn(() => Promise.resolve(options.pool ?? [])),
  } as unknown as FamiliarPoolService;

  const rank = vi.fn((request: RecommendationRequest): Promise<RankedCandidates> => {
    const excluded = request.exclusions?.trackKeys ?? new Set<string>();
    const known = request.knownKeys ?? new Set<string>();
    const ranked =
      options.discoverySupply?.(request) ??
      (options.discoveries ?? []).filter(
        (entry) => !excluded.has(entry.trackKey) && !known.has(entry.trackKey),
      );
    return Promise.resolve({
      ranked,
      candidateCount: ranked.length,
      excludedCount: 0,
      strategies: ['fake'],
      reranked: false,
      timings: { candidateMs: 0, enrichMs: 0, scoreMs: 0 },
    });
  });
  const artistTags = vi.fn(() => Promise.resolve([] as readonly string[]));
  const recommender = { rank, artistTags } as unknown as RecommendationService;

  const resolveKnown = vi.fn((_room: unknown, candidate: FamiliarCandidate) =>
    Promise.resolve(playable(candidate.artist, candidate.title)),
  );
  const resolveDiscovery = vi.fn((_room: unknown, candidate: { title: string; artist: string }) =>
    Promise.resolve(playable(candidate.artist, candidate.title)),
  );

  const planner = new AutoplayPlanner({
    session,
    taste,
    familiar: familiarService,
    recommender,
    ...(options.dislikes === undefined ? {} : { dislikes: options.dislikes }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  planner.setResolvers({
    resolveKnown: options.resolvers?.resolveKnown ?? resolveKnown,
    resolveDiscovery: options.resolvers?.resolveDiscovery ?? resolveDiscovery,
  });

  return { planner, session, rank, resolveKnown, resolveDiscovery };
}

const seeds: readonly TrackSeed[] = [{ title: 'Seed Song', artist: 'Seed Artist' }];

/** Discord id shaped like a real one, so `listenersOf` counts it. */
const LISTENER_ID = '111111111111111111';

/**
 * Put a listener in the room. The dislike ledger is only consulted for people
 * the session can name, so every dislike test needs one.
 */
async function withListener(session: AutoplaySessionStore): Promise<void> {
  await session.syncQueue(ROOM.roomId, [
    entryOf(playable('Requester', 'Their Own Pick'), {
      origin: 'user',
      requestedById: LISTENER_ID,
    }),
  ]);
}

/**
 * Run `batches` generation cycles, recording every served track as played and
 * moving the clock on one song per track — the batch boundary is where cadence
 * and cooldown both have to survive, so the simulation must cross it for real.
 *
 * Returns the tracks PER CYCLE: "did any cycle come back empty?" is the whole
 * question this file exists to answer, and a flat list cannot express it.
 */
async function playThrough(
  h: Harness,
  batches: number,
  count = 2,
  trackMs = TRACK_MS,
): Promise<readonly (readonly QueuedTrack[])[]> {
  const cycles: (readonly QueuedTrack[])[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const generated = await h.planner.generate(ROOM, seeds, count, { background: false });
    for (const entry of generated) {
      await h.session.recordPlayed(ROOM.roomId, {
        ...entryOf(entry.track),
        origin: 'autoplay',
        ...(entry.track.autoplayKind === undefined ? {} : { kind: entry.track.autoplayKind }),
      });
      advance(trackMs);
    }
    cycles.push(generated.map((entry) => entry.track));
  }
  return cycles;
}

function library(size: number, prefix = 'Lib'): FamiliarCandidate[] {
  return Array.from({ length: size }, (_, index) =>
    familiar(`${prefix} Artist ${String(index)}`, `${prefix} Song ${String(index)}`, ['library'], {
      plays: 3,
      userPlays: 2,
      completions: 3,
    }),
  );
}

function discoveryBatch(batch: number, size: number): ScoredCandidate[] {
  return Array.from({ length: size }, (_, index) =>
    scored(
      discovery(
        `Radio Artist ${String(batch)}-${String(index)}`,
        `Radio Song ${String(batch)}-${String(index)}`,
      ),
      0.7 - index * 0.01,
    ),
  );
}

/**
 * A discovery source that behaves like the real one: it answers with whatever
 * of its current neighbourhood is still eligible, and when the room has heard
 * all of it, the seeds have moved on and it returns a fresh neighbourhood.
 */
function regeneratingDiscoveries(size: number): {
  readonly supply: (request: RecommendationRequest) => readonly ScoredCandidate[];
  readonly batches: () => number;
} {
  let batch = 0;
  let current = discoveryBatch(batch, size);
  const supply = (request: RecommendationRequest): readonly ScoredCandidate[] => {
    const excluded = request.exclusions?.trackKeys ?? new Set<string>();
    const known = request.knownKeys ?? new Set<string>();
    const eligible = (entries: readonly ScoredCandidate[]): ScoredCandidate[] =>
      entries.filter((entry) => !excluded.has(entry.trackKey) && !known.has(entry.trackKey));

    // Last.fm's neighbourhood moves with the seeds: once most of the current
    // one has been heard, the rotating anchors surface a fresh set rather
    // than waiting for the last straggler to be consumed.
    const left = eligible(current);
    if (left.length >= Math.ceil(size / 3)) return left;
    batch += 1;
    current = discoveryBatch(batch, size);
    return eligible(current);
  };
  return { supply, batches: () => batch + 1 };
}

function dislikeSource(options: {
  readonly keys?: readonly string[];
  readonly artists?: Readonly<Record<string, number>>;
}): DislikeSource {
  return {
    dislikesFor: () =>
      Promise.resolve({
        keys: new Set(options.keys ?? []),
        artistCounts: new Map(Object.entries(options.artists ?? {})),
      }),
  };
}

const keyOf = (track: Pick<QueuedTrack, 'author' | 'title'>): string =>
  identityOf(track.author, track.title).key;

/** Lengths of the familiar runs BETWEEN two discoveries (leading/trailing runs excluded). */
function familiarRunsBetweenDiscoveries(kinds: readonly (string | undefined)[]): number[] {
  const first = kinds.indexOf('discovery');
  const last = kinds.lastIndexOf('discovery');
  if (first === -1 || last === first) return [];
  const runs: number[] = [];
  let run = 0;
  for (const kind of kinds.slice(first + 1, last + 1)) {
    if (kind === 'discovery') {
      runs.push(run);
      run = 0;
    } else {
      run += 1;
    }
  }
  return runs;
}

/* --------------------------------------------------------------------- tests */

/**
 * The shared forty-cycle simulation: thirty rested library songs, a Last.fm
 * neighbourhood of twelve that renews itself as the room hears it, two tracks
 * generated per cycle, four minutes of simulated time per track. Deterministic,
 * so each property below can re-run it and fail on its own terms.
 */
async function longSession(): Promise<{
  readonly cycles: readonly (readonly QueuedTrack[])[];
  readonly played: readonly QueuedTrack[];
  readonly kinds: readonly (string | undefined)[];
  readonly batches: number;
}> {
  const supply = regeneratingDiscoveries(12);
  const h = harness({ pool: library(30), discoverySupply: supply.supply });
  const cycles = await playThrough(h, 40, 2);
  const played = cycles.flat();
  return {
    cycles,
    played,
    kinds: played.map((track) => track.autoplayKind),
    batches: supply.batches(),
  };
}

describe('AutoplayPlanner — a long session over a known library', () => {
  it('never leaves a refill cycle empty across eighty tracks', async () => {
    const { cycles, played } = await longSession();

    expect(cycles.flatMap((cycle, index) => (cycle.length === 0 ? [index] : []))).toEqual([]);
    expect(played.length).toBe(80);
  });

  /**
   * Pins the fix for a real starvation bug: by track ~40 every one of the thirty
   * library songs was inside the three-hour cooldown while the discovery
   * neighbourhood kept renewing itself. The planner used to relax the cooldown
   * only when BOTH pools were empty, so a live discovery pool locked the room's
   * own library away and it heard six unknown songs in a row. Relaxation is now
   * judged on the known pool alone.
   */
  it('keeps discovery a punctuation mark: never two in a row, never more than three familiars between', async () => {
    const { kinds } = await longSession();

    const backToBack = kinds.flatMap((kind, index) =>
      index > 0 && kind === 'discovery' && kinds[index - 1] === 'discovery' ? [index] : [],
    );
    expect(backToBack).toEqual([]);
    expect(familiarRunsBetweenDiscoveries(kinds).filter((run) => run > 3)).toEqual([]);
  });

  it('spends between a fifth and a third of the session on discovery', async () => {
    const { kinds, played } = await longSession();

    const share = kinds.filter((kind) => kind === 'discovery').length / played.length;
    expect(share).toBeGreaterThanOrEqual(0.2);
    expect(share).toBeLessThanOrEqual(0.35);
  });

  it('repeats a song only outside the play window and the (relaxed) cooldown', async () => {
    const { played } = await longSession();

    const lastSeenAt = new Map<string, number>();
    const tooSoon: { readonly key: string; readonly gap: number }[] = [];
    for (const [position, track] of played.entries()) {
      const key = keyOf(track);
      const previous = lastSeenAt.get(key);
      // Position gap × track length IS the simulated wall-clock gap. A
      // thirty-song library cycles in under three hours at this cadence, so
      // the session legitimately lives in the relaxed regime — half the
      // cooldown (90 min) and half the play window (6) — and never below it.
      if (
        previous !== undefined &&
        (position - previous <= 6 || (position - previous) * TRACK_MS < 1.5 * HOUR)
      ) {
        tooSoon.push({ key, gap: position - previous });
      }
      lastSeenAt.set(key, position);
    }

    expect(tooSoon).toEqual([]);
    // A session this long over a library this small MUST repeat something —
    // otherwise the assertion above passes for the wrong reason.
    expect(new Set(played.map(keyOf)).size).toBeLessThan(played.length);
  });

  it('plays songs from a later neighbourhood as the seeds rotate', async () => {
    const { played, batches } = await longSession();

    expect(batches).toBeGreaterThan(1);
    expect(played.some((track) => track.author.startsWith('Radio Artist 1-'))).toBe(true);
  });
});

describe('AutoplayPlanner — a small library with nothing new to play', () => {
  it('rotates six songs forever instead of falling silent, honouring the relaxed cooldown', async () => {
    // Cooldown chosen so the RELAXED regime is exactly the spec floor —
    // max(30 min, 60 min / 2) = 30 min and max(3, 6 / 2) = 3 plays — which is
    // the regime a six-song library actually lives in.
    const h = harness({
      pool: library(6, 'Small'),
      discoveries: [],
      config: { repeatCooldownMs: HOUR, repeatCooldownPlays: 6 },
    });

    // Six-minute songs: six of them out-last the 30-minute floor, which is what
    // makes a library this small survivable at all.
    const cycles = await playThrough(h, 20, 2, 6 * MINUTE);
    const played = cycles.flat();

    for (const [index, cycle] of cycles.entries()) {
      expect({ cycle: index, served: cycle.length === 0 }).toEqual({ cycle: index, served: false });
    }

    const lastSeenAt = new Map<string, number>();
    for (const [position, track] of played.entries()) {
      const key = keyOf(track);
      const previous = lastSeenAt.get(key);
      if (previous !== undefined) {
        // Relaxed position rule: at least the last three plays in between.
        expect(position - previous).toBeGreaterThanOrEqual(4);
        // Relaxed time rule: 30 minutes of rest, floor, never relaxed further.
        expect((position - previous) * 6 * MINUTE).toBeGreaterThanOrEqual(30 * MINUTE);
      }
      lastSeenAt.set(key, position);
    }

    const log = (await h.session.snapshot(ROOM.roomId)).recentEntries;
    for (let index = 1; index < log.length; index += 1) {
      expect(log[index]?.key).not.toBe(log[index - 1]?.key);
    }
  });
});

describe('AutoplayPlanner — the repeat cooldown', () => {
  it('brings back a song from four hours ago but not one from an hour ago', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    // Both songs sit outside the twelve-play window, so only the CLOCK can
    // separate them: thirteen unrelated plays are pushed on top of them.
    await session.recordPlayed(ROOM.roomId, {
      ...entryOf(playable('Rested Artist', 'Four Hours Ago')),
      playedAt: clock - 4 * HOUR,
    });
    await session.recordPlayed(ROOM.roomId, {
      ...entryOf(playable('Fresh Artist', 'One Hour Ago')),
      playedAt: clock - 1 * HOUR,
    });
    for (let index = 0; index < 13; index += 1) {
      await session.recordPlayed(ROOM.roomId, {
        ...entryOf(playable('Filler Artist', `Filler ${String(index)}`)),
        playedAt: clock - 30 * MINUTE,
      });
    }

    const h = harness({
      session,
      discoveries: [],
      pool: [
        familiar('Fresh Artist', 'One Hour Ago', ['library'], {
          plays: 3,
          userPlays: 2,
          completions: 3,
          lastPlayedAt: clock - 1 * HOUR,
        }),
        familiar('Rested Artist', 'Four Hours Ago', ['library'], {
          plays: 3,
          userPlays: 2,
          completions: 3,
          lastPlayedAt: clock - 4 * HOUR,
        }),
      ],
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Four Hours Ago']);
  });

  it('refuses a song still inside the recent-plays window however long ago it played', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await session.recordPlayed(ROOM.roomId, {
      ...entryOf(playable('Ancient Artist', 'Ten Hours Ago')),
      playedAt: clock - 10 * HOUR,
    });
    for (let index = 0; index < 3; index += 1) {
      await session.recordPlayed(ROOM.roomId, {
        ...entryOf(playable('Filler Artist', `Filler ${String(index)}`)),
        playedAt: clock - 5 * MINUTE,
      });
    }

    const h = harness({
      session,
      discoveries: [],
      pool: [
        familiar('Ancient Artist', 'Ten Hours Ago', ['library'], {
          plays: 3,
          userPlays: 2,
          completions: 3,
          lastPlayedAt: clock - 10 * HOUR,
        }),
        familiar('Never Artist', 'Never Played', ['library'], {
          plays: 3,
          userPlays: 2,
          completions: 3,
        }),
      ],
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    // At index 3 of the recent ring it is still one of the last twelve plays.
    expect(generated.map((entry) => entry.track.title)).toEqual(['Never Played']);
  });
});

describe('AutoplayPlanner — the relaxed second pass', () => {
  /** Relaxed regime becomes exactly max(30 min, 30 min) and max(3, 3) plays. */
  const relaxable = { repeatCooldownMs: HOUR, repeatCooldownPlays: 6 } as const;

  it('revives the oldest of four recently played songs rather than returning nothing', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    const pool = library(4, 'Only');
    for (const candidate of pool) {
      await session.recordPlayed(ROOM.roomId, {
        ...entryOf(playable(candidate.artist, candidate.title)),
        playedAt: clock - 1 * HOUR,
      });
    }

    const h = harness({ session, pool, discoveries: [], config: relaxable });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    // Normal pass: all four are inside the hour. Relaxed pass: the floor is
    // 30 minutes and the position window is three plays, so exactly the one at
    // index 3 — the oldest — comes back.
    expect(generated.map((entry) => entry.track.title)).toEqual(['Only Song 0']);
  });

  it('still returns nothing when even the relaxed floor has not elapsed', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    const pool = library(4, 'Only');
    for (const candidate of pool) {
      await session.recordPlayed(ROOM.roomId, {
        ...entryOf(playable(candidate.artist, candidate.title)),
        playedAt: clock - 10 * MINUTE,
      });
    }

    const h = harness({ session, pool, discoveries: [], config: relaxable });

    expect(await h.planner.generate(ROOM, seeds, 2, { background: false })).toEqual([]);
  });
});

describe('AutoplayPlanner — dislikes', () => {
  it('never serves a disliked known song, however well it scores', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await withListener(session);
    const hated = familiar('Nope Artist', 'Nope Song', ['requested'], {
      plays: 9,
      userPlays: 9,
      completions: 9,
      listenerCount: 3,
    });
    const h = harness({
      session,
      pool: [hated, ...library(4)],
      discoveries: discoveryBatch(0, 20),
      dislikes: dislikeSource({ keys: [identityOf('Nope Artist', 'Nope Song').key] }),
    });

    const played = (await playThrough(h, 10)).flat();

    expect(played.length).toBeGreaterThan(0);
    expect(played.map((track) => track.title)).not.toContain('Nope Song');
  });

  it('never serves a disliked discovery candidate and hands the exclusion to the recommender', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await withListener(session);
    const hatedKey = identityOf('Bad Rec', 'Bad Song').key;
    const h = harness({
      session,
      pool: [],
      discoveries: [scored(discovery('Bad Rec', 'Bad Song'), 0.95), ...discoveryBatch(0, 6)],
      dislikes: dislikeSource({ keys: [hatedKey] }),
    });

    const played = (await playThrough(h, 3)).flat();

    expect(played.length).toBeGreaterThan(0);
    expect(played.map((track) => track.title)).not.toContain('Bad Song');
    const request = h.rank.mock.calls[0]?.[0] as RecommendationRequest;
    expect(request.exclusions?.trackKeys.has(hatedKey)).toBe(true);
  });

  it('excludes from the session mirror alone, before any store is consulted', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await session.recordDisliked(ROOM.roomId, [identityOf('Mirror Artist', 'Mirror Song').key]);
    const h = harness({
      session,
      discoveries: [],
      pool: [
        familiar('Mirror Artist', 'Mirror Song', ['requested'], {
          plays: 9,
          userPlays: 9,
          completions: 9,
          listenerCount: 3,
        }),
        familiar('Fine Artist', 'Fine Song', ['library'], { plays: 3, completions: 3 }),
      ],
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Fine Song']);
  });

  it('carries a dislike across providers: a Spotify-keyed dislike blocks the YouTube upload', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await withListener(session);
    // Disliked from a Spotify-titled track; the pool holds the YouTube spelling.
    const spotifyKey = identityOf('The Weeknd', 'Blinding Lights').key;
    expect(identityOf('The Weeknd', 'Blinding Lights (Official Video)').key).toBe(spotifyKey);

    const h = harness({
      session,
      discoveries: [],
      pool: [
        familiar('The Weeknd', 'Blinding Lights (Official Video)', ['requested'], {
          plays: 9,
          userPlays: 9,
          completions: 9,
          listenerCount: 3,
        }),
        familiar('Fine Artist', 'Fine Song', ['library'], { plays: 3, completions: 3 }),
      ],
      dislikes: dislikeSource({ keys: [spotifyKey] }),
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Fine Song']);
  });
});

describe('AutoplayPlanner — a disliked song is not a blacklisted artist', () => {
  it('ranks the rest of the artist below equally-scored others but still plays them', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    await withListener(session);
    const artistX = ['One', 'Two', 'Three'].map((suffix) =>
      familiar('Artist X', `X Song ${suffix}`, ['library'], {
        plays: 3,
        userPlays: 2,
        completions: 3,
      }),
    );
    const h = harness({
      session,
      discoveries: [],
      pool: [...artistX, ...library(3, 'Other')],
      dislikes: dislikeSource({ artists: { [identityOf('Artist X', 'anything').artistKey]: 1 } }),
    });

    const played = (await playThrough(h, 6, 1)).flat();
    const titles = played.map((track) => track.title);

    // Penalised, so the untouched artists go first...
    expect(titles.slice(0, 3)).toEqual(['Other Song 0', 'Other Song 1', 'Other Song 2']);
    // ...but not banned: Artist X still gets played.
    expect(titles.some((title) => title.startsWith('X Song'))).toBe(true);
  });
});

describe('AutoplayPlanner — a skip is not a dislike', () => {
  it('holds a skipped known song back but plays it once it is the only rested candidate', async () => {
    const skipped = familiar('Skipped Artist', 'Skipped Song', ['requested'], {
      plays: 9,
      userPlays: 9,
      completions: 9,
      listenerCount: 3,
    });
    const recent: RecentContext = {
      ...EMPTY_RECENT_CONTEXT,
      skippedKeys: [identityOf('Skipped Artist', 'Skipped Song').key],
    };
    const h = harness({
      recent,
      discoveries: [],
      pool: [
        skipped,
        familiar('Kept Artist', 'Kept Song', ['library'], {
          plays: 3,
          userPlays: 2,
          completions: 3,
        }),
      ],
    });

    const played = (await playThrough(h, 2, 1)).flat();

    expect(played.map((track) => track.title)).toEqual(['Kept Song', 'Skipped Song']);
  });

  it('ranks a previously rejected discovery below an otherwise equal one', async () => {
    const rejectedKey = identityOf('Rejected Artist', 'Rejected Song').key;
    const recent: RecentContext = { ...EMPTY_RECENT_CONTEXT, skippedKeys: [rejectedKey] };
    const pair = [
      scored(discovery('Rejected Artist', 'Rejected Song'), 0.7),
      scored(discovery('Fresh Artist', 'Fresh Song'), 0.7),
    ];
    const h = harness({
      recent,
      pool: [],
      // The recommender is where a skip is priced in; the planner's job is to
      // hand it the recency context and then respect the order it comes back in.
      discoverySupply: (request) =>
        pair
          .map((entry) =>
            request.recent.skippedKeys.includes(entry.trackKey)
              ? { ...entry, breakdown: { ...entry.breakdown, final: entry.breakdown.final - 0.2 } }
              : entry,
          )
          .sort((a, b) => b.breakdown.final - a.breakdown.final),
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(h.rank.mock.calls[0]?.[0]).toMatchObject({
      recent: expect.objectContaining({ skippedKeys: [rejectedKey] }) as unknown,
    });
    expect(generated.map((entry) => entry.track.title)).toEqual(['Fresh Song', 'Rejected Song']);
  });
});

describe('AutoplayPlanner — surviving a restart', () => {
  /**
   * A restart loses the in-memory session. What survives is the persisted
   * queue: tracks with their requester and, for autoplay picks, their kind.
   * The music manager re-syncs those into a fresh session store, and the
   * planner must pick up the listener AND the cadence from that alone.
   */
  it("continues the same listener's radio and cadence from a restored queue", async () => {
    const before = harness({
      pool: library(30),
      discoverySupply: regeneratingDiscoveries(12).supply,
    });
    const played = (await playThrough(before, 6)).flat();
    expect(played).toHaveLength(12);

    // --- restart: new store, only the persisted queue's tracks come back ---
    const restored = new AutoplaySessionStore({ now: () => clock });
    const listenerId = '111111111111111111';
    await restored.setListener(ROOM.roomId, listenerId);
    await restored.syncQueue(ROOM.roomId, [
      {
        ...entryOf(playable('Someone', 'Their Request')),
        origin: 'user',
        requestedById: listenerId,
      },
      ...played.slice(-3).map((track) => ({
        ...entryOf(track),
        origin: 'autoplay' as const,
        ...(track.autoplayKind === undefined ? {} : { kind: track.autoplayKind }),
      })),
    ]);
    const snap = await restored.snapshot(ROOM.roomId);
    expect(snap.listenerIds[0]).toBe(listenerId);
    expect(snap.recentAutoplayKinds.length).toBe(3);

    const after = harness({
      pool: library(30),
      discoverySupply: regeneratingDiscoveries(12).supply,
      session: restored,
    });
    const continued = (await playThrough(after, 6)).flat();

    expect(continued).toHaveLength(12);
    // The three restored autoplay picks are queued, so they cannot be served again.
    const queuedKeys = new Set(played.slice(-3).map(keyOf));
    expect(continued.some((track) => queuedKeys.has(keyOf(track)))).toBe(false);
    // Cadence held across the restart: never two discoveries in a row.
    const kinds = continued.map((track) => track.autoplayKind);
    for (let index = 1; index < kinds.length; index += 1) {
      expect(kinds[index] === 'discovery' && kinds[index - 1] === 'discovery').toBe(false);
    }
  });

  it('respects a dislike made after the restart, and forgets it when withdrawn', async () => {
    const session = new AutoplaySessionStore({ now: () => clock });
    const favourite = familiar('Loved Artist', 'Loved Song', ['library'], {
      plays: 9,
      userPlays: 9,
      completions: 9,
      lastPlayedAt: null,
    });
    const h = harness({ pool: [favourite, ...library(3)], session });

    const first = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(first[0]?.track.title).toBe('Loved Song');
    await session.release(
      ROOM.roomId,
      first.map((entry) => entry.reservedKey),
    );

    await session.recordDisliked(ROOM.roomId, [identityOf(favourite.artist, favourite.title).key]);
    const disliked = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(disliked[0]?.track.title).not.toBe('Loved Song');
    await session.release(
      ROOM.roomId,
      disliked.map((entry) => entry.reservedKey),
    );

    await session.forgetDisliked(ROOM.roomId, [identityOf(favourite.artist, favourite.title).key]);
    const forgiven = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(forgiven[0]?.track.title).toBe('Loved Song');
  });
});

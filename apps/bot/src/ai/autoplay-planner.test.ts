import { describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import { AutoplayPlanner, type PlannerResolvers } from './autoplay-planner.js';
import { CacheService } from './cache.js';
import type { CooccurrenceService, CooccurrenceSignals } from './cooccurrence.js';
import { TrackProfileResolver } from './track-profile.js';
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
  type TasteScope,
  type UserTasteService,
} from './taste.js';

/** Autoplay is scoped to a voice channel now; one room stands in for the old guild. */
const ROOM = roomRefOf('guild', 'vc-1');

/* ------------------------------------------------------------------ fixtures */

const HOUR = 60 * 60_000;
const NOW = Date.now();

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
    lastPlayedAt: NOW - 48 * HOUR,
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
  readonly profileCalls: (string | TasteScope)[];
  readonly profileOptions: {
    readonly scope: TasteScope;
    readonly options: unknown;
  }[];
}

/**
 * The planner with every collaborator faked at its seam. Resolvers default to
 * "every song plays", so a test that wants a failure overrides them.
 */
function harness(options: {
  readonly pool?: readonly FamiliarCandidate[];
  readonly discoveries?: readonly ScoredCandidate[];
  readonly recent?: RecentContext;
  readonly profile?: TasteProfile;
  readonly resolvers?: Partial<PlannerResolvers>;
  readonly config?: ConstructorParameters<typeof AutoplayPlanner>[0]['config'];
  readonly session?: AutoplaySessionStore;
  /** Tags the fake recommender returns per artist, for the enrichment pass. */
  readonly artistTags?: Readonly<Record<string, readonly string[]>>;
  /** Behavioural signals the fake co-occurrence service returns. */
  readonly behaviour?: CooccurrenceSignals;
  /** A profile resolver; when given, the shortlist is enriched through it. */
  readonly profiles?: TrackProfileResolver;
}): Harness {
  const session = options.session ?? new AutoplaySessionStore();
  const profileCalls: Harness['profileCalls'] = [];
  const profileOptions: Harness['profileOptions'] = [];

  const taste = {
    profile: vi.fn((scope: TasteScope, opts?: unknown) => {
      profileCalls.push(scope);
      profileOptions.push({ scope, options: opts });
      return Promise.resolve(options.profile ?? EMPTY_TASTE_PROFILE);
    }),
    recentContext: vi.fn(() => Promise.resolve(options.recent ?? EMPTY_RECENT_CONTEXT)),
  } as unknown as UserTasteService;

  const familiarService = {
    pool: vi.fn(() => Promise.resolve(options.pool ?? [])),
  } as unknown as FamiliarPoolService;

  const rank = vi.fn((request: RecommendationRequest): Promise<RankedCandidates> => {
    const excluded = request.exclusions?.trackKeys ?? new Set<string>();
    const known = request.knownKeys ?? new Set<string>();
    const ranked = (options.discoveries ?? []).filter(
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
  const artistTags = vi.fn((artist: string) =>
    Promise.resolve(options.artistTags?.[artist] ?? ([] as readonly string[])),
  );
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
    ...(options.behaviour === undefined
      ? {}
      : {
          cooccurrence: {
            signals: vi.fn(() => Promise.resolve(options.behaviour)),
          } as unknown as CooccurrenceService,
        }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    config: { languageSpecific: false, ...options.config },
  });
  planner.setResolvers({
    resolveKnown: options.resolvers?.resolveKnown ?? resolveKnown,
    resolveDiscovery: options.resolvers?.resolveDiscovery ?? resolveDiscovery,
    // Absent by default: without a room to ask about, every remembered
    // listener counts, which is what most of these tests are asserting.
    ...(options.resolvers?.presentListeners === undefined
      ? {}
      : { presentListeners: options.resolvers.presentListeners }),
  });

  return { planner, session, rank, resolveKnown, resolveDiscovery, profileCalls, profileOptions };
}

const seeds: readonly TrackSeed[] = [{ title: 'Seed Song', artist: 'Seed Artist' }];

describe('strict language-specific autoplay', () => {
  it('rejects a resolved upload in a different language and releases its reservation', async () => {
    const profiles = new TrackProfileResolver(
      {
        artistTags: () => Promise.resolve([]),
        trackTags: (_artist, title) =>
          Promise.resolve([title === 'Wrong upload' ? 'hindi' : 'english']),
      },
      new CacheService(),
    );
    const h = harness({
      profiles,
      config: { languageSpecific: true },
      pool: [familiar('Singer', 'English song', ['library'])],
      resolvers: { resolveKnown: () => Promise.resolve(playable('Other singer', 'Wrong upload')) },
    });
    expect(await h.planner.generate(ROOM, seeds, 1, { background: false })).toEqual([]);
    expect((await h.session.snapshot(ROOM.roomId)).reservedKeys.size).toBe(0);
  });
  it.each(['english', 'hindi', 'marathi'])(
    'keeps both pools in %s even when other languages score higher',
    async (language) => {
      const profiles = new TrackProfileResolver(
        {
          artistTags: () => Promise.resolve(['indian']),
          trackTags: (_artist, title) =>
            Promise.resolve(
              title === 'Seed Song' ? [language] : title === 'Unknown' ? [] : [title],
            ),
        },
        new CacheService(),
      );
      const h = harness({
        profiles,
        config: { languageSpecific: true },
        pool: ['english', 'hindi', 'marathi', 'Unknown'].map((title) =>
          familiar(`Singer ${title}`, title, ['library']),
        ),
        discoveries: ['english', 'hindi', 'marathi', 'Unknown'].map((title) =>
          scored(discovery(`Discovery ${title}`, title), 0.99),
        ),
      });
      const generated = await h.planner.generate(ROOM, seeds, 3, { background: false });
      expect(generated.length).toBeGreaterThan(0);
      expect(generated.every((entry) => entry.track.title === language)).toBe(true);
      expect(h.rank).toHaveBeenCalledWith(
        expect.objectContaining({ intent: expect.objectContaining({ language }) }),
      );
    },
  );
  it('does not fall back to another language when no matching songs exist', async () => {
    const profiles = new TrackProfileResolver(
      {
        artistTags: () => Promise.resolve([]),
        trackTags: (_artist, title) =>
          Promise.resolve([title === 'Seed Song' ? 'marathi' : 'hindi']),
      },
      new CacheService(),
    );
    const h = harness({
      profiles,
      config: { languageSpecific: true },
      pool: [familiar('Singer', 'Hindi track', ['library'])],
    });
    expect(await h.planner.generate(ROOM, seeds, 3, { background: false })).toEqual([]);
    expect(h.resolveKnown).not.toHaveBeenCalled();
  });
  it('does not guess English from Latin text or Hindi from shared Devanagari', async () => {
    const profiles = new TrackProfileResolver(
      { artistTags: () => Promise.resolve(['american']), trackTags: () => Promise.resolve([]) },
      new CacheService(),
    );
    const h = harness({
      profiles,
      config: { languageSpecific: true },
      pool: [familiar('Singer', 'Song', ['library'])],
    });
    for (const title of ['Seed Song', 'मराठी गाणे']) {
      expect(
        await h.planner.generate(ROOM, [{ title, artist: 'Singer' }], 2, { background: false }),
      ).toEqual([]);
    }
  });
});

/** Generate `batches` × `count` tracks, recording each as played so the cadence carries. */
async function playThrough(
  h: Harness,
  batches: number,
  count = 2,
): Promise<readonly QueuedTrack[]> {
  const played: QueuedTrack[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const generated = await h.planner.generate(ROOM, seeds, count, { background: false });
    for (const entry of generated) {
      played.push(entry.track);
      await h.session.recordPlayed(ROOM.roomId, {
        ...entryOf(entry.track),
        origin: 'autoplay',
        ...(entry.track.autoplayKind === undefined ? {} : { kind: entry.track.autoplayKind }),
      });
    }
  }
  return played;
}

function bigLibrary(size: number): FamiliarCandidate[] {
  return Array.from({ length: size }, (_, index) =>
    familiar(`Lib Artist ${String(index)}`, `Lib Song ${String(index)}`, ['library'], {
      plays: 3,
      userPlays: 2,
      completions: 3,
    }),
  );
}

function manyDiscoveries(size: number): ScoredCandidate[] {
  return Array.from({ length: size }, (_, index) =>
    scored(
      discovery(`New Artist ${String(index)}`, `New Song ${String(index)}`),
      0.7 - index * 0.01,
    ),
  );
}

/* --------------------------------------------------------------------- tests */

describe('AutoplayPlanner — scenario A: a listener with a deep known pool', () => {
  it('plays mostly known songs with exactly one discovery every few tracks, across batches', async () => {
    const h = harness({ pool: bigLibrary(20), discoveries: manyDiscoveries(10) });

    const played = await playThrough(h, 6);
    const kinds = played.map((track) => track.autoplayKind);

    expect(played.length).toBe(12);
    const discoveries = kinds.filter((kind) => kind === 'discovery').length;
    // Strong pool → runs of three: 12 tracks hold three discoveries.
    expect(discoveries).toBe(3);
    // Never two discoveries in a row, never four familiars in a row.
    for (let index = 1; index < kinds.length; index += 1) {
      expect(kinds[index] === 'discovery' && kinds[index - 1] === 'discovery').toBe(false);
    }
    expect(kinds.slice(0, 4)).toEqual(['familiar', 'familiar', 'familiar', 'discovery']);
    // Every played track is a distinct song.
    expect(new Set(played.map((track) => identityOf(track.author, track.title).key)).size).toBe(12);
  });
});

describe('AutoplayPlanner — scenario B: only two requested songs, but history exists', () => {
  it('draws the next songs from history/library before any discovery', async () => {
    const history = [
      familiar('Hist A', 'Song A', ['history'], { plays: 2, userPlays: 1, completions: 2 }),
      familiar('Hist B', 'Song B', ['history'], { plays: 2, userPlays: 1, completions: 2 }),
      familiar('Lib C', 'Song C', ['library']),
    ];
    const h = harness({ pool: history, discoveries: manyDiscoveries(5) });

    const played = await playThrough(h, 3);
    const kinds = played.map((track) => track.autoplayKind);

    // Thin pool (< 6 strong) → run of two, then a discovery.
    expect(kinds.slice(0, 3)).toEqual(['familiar', 'familiar', 'discovery']);
    expect(
      played
        .slice(0, 2)
        .every((track) => track.author.startsWith('Hist') || track.author.startsWith('Lib')),
    ).toBe(true);
  });
});

describe('AutoplayPlanner — scenario C: a playlist is selected by relevance, not order', () => {
  it('prefers the playlist tracks that match taste and context over sequential order', async () => {
    const profile: TasteProfile = {
      ...EMPTY_TASTE_PROFILE,
      artistAffinity: { 'artist a': 0.9, 'artist c': 0.8, 'artist f': 0.85, 'artist b': -0.6 },
      confidence: 1,
      sampleSize: 100,
    };
    const playlist = ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) =>
      familiar(`Artist ${letter}`, `Track ${letter}`, ['playlist'], { playlistRelevance: 0.5 }),
    );
    const h = harness({ pool: playlist, discoveries: [], profile });

    const played = await playThrough(h, 2, 3);
    const order = played.map((track) => track.author.replace('Artist ', ''));

    expect(order.slice(0, 3).sort()).toEqual(['A', 'C', 'F']);
    expect(order.at(-1)).toBe('B');
  });
});

describe('AutoplayPlanner — scenario D: a new user with nothing known', () => {
  it('serves discoveries seeded from the request rather than nothing', async () => {
    const h = harness({ pool: [], discoveries: manyDiscoveries(4) });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(generated.length).toBe(2);
    expect(generated.every((entry) => entry.track.autoplayKind === 'discovery')).toBe(true);
    expect(generated.every((entry) => entry.track.origin === 'autoplay')).toBe(true);
    const request = h.rank.mock.calls[0]?.[0] as RecommendationRequest;
    expect(request.seeds).toEqual(seeds);
  });

  it('returns nothing rather than filler when no pool has a candidate', async () => {
    const h = harness({ pool: [], discoveries: [] });
    expect(await h.planner.generate(ROOM, seeds, 2, { background: false })).toEqual([]);
  });
});

describe('AutoplayPlanner — discovery novelty', () => {
  it('hands the recommender every known key so discoveries cannot be songs the listener already has', async () => {
    const known = familiar('Known Artist', 'Known Song', ['library']);
    const h = harness({
      pool: [known],
      discoveries: [
        scored(discovery('Known Artist', 'Known Song (Official Video)'), 0.9),
        ...manyDiscoveries(3),
      ],
    });

    const played = await playThrough(h, 3, 1);

    const request = h.rank.mock.calls[0]?.[0] as RecommendationRequest;
    expect(request.knownKeys?.has(identityOf('Known Artist', 'Known Song').key)).toBe(true);
    const asDiscovery = played.filter(
      (track) => track.autoplayKind === 'discovery' && track.author === 'Known Artist',
    );
    expect(asDiscovery).toEqual([]);
  });
});

describe('AutoplayPlanner — duplicate prevention', () => {
  it('never serves what is playing, queued, reserved, recently played or the seed itself', async () => {
    const playing = playable('Artist P', 'Playing');
    const queued = playable('Artist Q', 'Queued');
    const recent = playable('Artist R', 'Recent');
    const session = new AutoplaySessionStore();
    await session.recordPlayed(ROOM.roomId, entryOf(recent));
    await session.syncQueue(ROOM.roomId, [entryOf(playing), entryOf(queued)]);
    await session.reserve(ROOM.roomId, [identityOf('Artist V', 'Reserved').key]);

    const pool = [
      familiar('Artist P', 'Playing', ['library']),
      familiar('Artist Q', 'Queued', ['library']),
      familiar('Artist R', 'Recent', ['library']),
      familiar('Artist V', 'Reserved', ['library']),
      familiar('Seed Artist', 'Seed Song', ['library']),
      familiar('Artist OK', 'Fine', ['library']),
    ];
    const h = harness({ pool, discoveries: [], session });

    const generated = await h.planner.generate(ROOM, seeds, 5, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Fine']);
  });

  it('blocks a pick whose resolved upload turns out to be an already-played song', async () => {
    const session = new AutoplaySessionStore();
    await session.recordPlayed(ROOM.roomId, entryOf(playable('Artist X', 'Song X', 'vid-x')));
    const resolveKnown = vi.fn((_room: unknown, candidate: FamiliarCandidate) =>
      // Two different catalogue spellings resolve to the very same upload.
      Promise.resolve(
        candidate.title === 'Song Y'
          ? playable('Artist X', 'Song X', 'vid-x')
          : playable(candidate.artist, candidate.title),
      ),
    );
    const h = harness({
      pool: [
        familiar('Artist Y', 'Song Y', ['library']),
        familiar('Artist Z', 'Song Z', ['library']),
      ],
      session,
      resolvers: { resolveKnown },
    });

    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Song Z']);
    // The blocked pick's reservation was handed back.
    expect(
      (await session.snapshot(ROOM.roomId)).reservedKeys.has(identityOf('Artist Y', 'Song Y').key),
    ).toBe(false);
  });

  it('reserves every served pick so a concurrent pass cannot select it', async () => {
    const h = harness({ pool: bigLibrary(3) });
    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });
    const snapshot = await h.session.snapshot(ROOM.roomId);
    for (const entry of generated) expect(snapshot.reservedKeys.has(entry.reservedKey)).toBe(true);
  });
});

describe('AutoplayPlanner — behavioural signals', () => {
  it('deprioritises a known song the room skipped early', async () => {
    const pool = [
      familiar('Artist S', 'Skipped Song', ['library'], {
        plays: 3,
        earlySkips: 3,
        completions: 0,
      }),
      familiar('Artist K', 'Kept Song', ['library'], { plays: 3, completions: 3 }),
    ];
    const h = harness({ pool });
    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(generated[0]?.track.title).toBe('Kept Song');
  });

  it('prefers a frequently replayed, explicitly requested song over a stray history row', async () => {
    const pool = [
      familiar('Artist Once', 'Heard Once', ['history'], { plays: 2, completions: 1 }),
      familiar('Artist Loved', 'Replayed', ['history'], { plays: 6, userPlays: 3, completions: 6 }),
    ];
    const h = harness({ pool });
    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(generated[0]?.track.title).toBe('Replayed');
  });

  it('lets the current context (seed artist) pull a known song forward', async () => {
    const pool = [
      familiar('Other Artist', 'Unrelated', ['library']),
      familiar('Seed Artist', 'Same Artist Song', ['library']),
    ];
    const h = harness({ pool });
    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(generated[0]?.track.title).toBe('Same Artist Song');
  });

  it('holds back a favourite that played within the last two hours', async () => {
    const pool = [
      familiar('Artist Fresh', 'Just Played', ['library'], { lastPlayedAt: NOW - 30 * 60_000 }),
      familiar('Artist Rested', 'Rested', ['library'], { lastPlayedAt: NOW - 3 * 24 * HOUR }),
    ];
    const h = harness({ pool });
    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(generated[0]?.track.title).toBe('Rested');
  });

  it("blends each listener's own profile with the guild profile", async () => {
    const session = new AutoplaySessionStore();
    await session.syncQueue(ROOM.roomId, [
      entryOf(playable('U', 'One'), { origin: 'user', requestedById: '111111111111111111' }),
      entryOf(playable('U', 'Two'), { origin: 'user', requestedById: '222222222222222222' }),
    ]);
    const h = harness({ pool: bigLibrary(2), session });
    await h.planner.generate(ROOM, seeds, 1, { background: false });
    // Each listener's profile is scoped to THIS guild: their listening in
    // another server is that server's music, not this room's.
    expect(h.profileCalls).toEqual(
      expect.arrayContaining([
        { guildId: 'guild' },
        { guildId: 'guild', userId: '111111111111111111' },
        { guildId: 'guild', userId: '222222222222222222' },
      ]),
    );
  });

  it('personalises only around listeners who are still in the voice channel', async () => {
    const session = new AutoplaySessionStore();
    await session.syncQueue(ROOM.roomId, [
      entryOf(playable('U', 'One'), { origin: 'user', requestedById: '111111111111111111' }),
      entryOf(playable('U', 'Two'), { origin: 'user', requestedById: '222222222222222222' }),
    ]);
    const h = harness({
      pool: bigLibrary(2),
      session,
      // Only the first is still in the room; the second went home — and may
      // well be listening in a different server right now.
      resolvers: { presentListeners: () => ['111111111111111111'] },
    });

    await h.planner.generate(ROOM, seeds, 1, { background: false });

    expect(h.profileCalls).toEqual(
      expect.arrayContaining([{ guildId: 'guild', userId: '111111111111111111' }]),
    );
    expect(h.profileCalls).not.toEqual(
      expect.arrayContaining([{ guildId: 'guild', userId: '222222222222222222' }]),
    );
  });
});

describe('AutoplayPlanner — resolution and provider independence', () => {
  it('falls through to the next-ranked known song when the best one cannot be resolved', async () => {
    const resolveKnown = vi.fn((_room: unknown, candidate: FamiliarCandidate) =>
      Promise.resolve(
        candidate.title === 'Dead Upload' ? null : playable(candidate.artist, candidate.title),
      ),
    );
    const pool = [
      familiar('Artist Dead', 'Dead Upload', ['library'], {
        plays: 9,
        userPlays: 9,
        completions: 9,
      }),
      familiar('Artist Alive', 'Alive', ['library']),
    ];
    const h = harness({ pool, resolvers: { resolveKnown } });

    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });

    expect(generated.map((entry) => entry.track.title)).toEqual(['Alive']);
    expect(
      (await h.session.snapshot(ROOM.roomId)).reservedKeys.has(
        identityOf('Artist Dead', 'Dead Upload').key,
      ),
    ).toBe(false);
  });

  it('never decides a provider: known songs go to resolveKnown with their runtime, discoveries to resolveDiscovery', async () => {
    const h = harness({ pool: bigLibrary(2), discoveries: manyDiscoveries(2) });
    const session = h.session;
    await session.recordPlayed(ROOM.roomId, {
      ...entryOf(playable('a', 'b')),
      origin: 'autoplay',
      kind: 'familiar',
    });
    await session.recordPlayed(ROOM.roomId, {
      ...entryOf(playable('c', 'd')),
      origin: 'autoplay',
      kind: 'familiar',
    });

    const generated = await h.planner.generate(ROOM, seeds, 2, { background: false });

    expect(generated.map((entry) => entry.track.autoplayKind)).toEqual(['discovery', 'familiar']);
    expect(h.resolveKnown).toHaveBeenCalledTimes(1);
    expect(h.resolveKnown.mock.calls[0]?.[0]).toMatchObject({ roomId: ROOM.roomId });
    expect(h.resolveKnown.mock.calls[0]?.[1]).toMatchObject({ durationMs: 200_000 });
    expect(h.resolveDiscovery).toHaveBeenCalledTimes(1);
    expect(h.resolveDiscovery.mock.calls[0]?.[1]).toEqual({
      title: 'New Song 0',
      artist: 'New Artist 0',
    });
  });

  it('stamps every served track as autoplay-originated with its kind and candidate key', async () => {
    const h = harness({ pool: bigLibrary(1) });
    const [entry] = await h.planner.generate(ROOM, seeds, 1, { background: false });
    expect(entry?.track.origin).toBe('autoplay');
    expect(entry?.track.autoplayKind).toBe('familiar');
    expect(entry?.track.sourceKey).toBe(entry?.reservedKey);
  });

  it('disables discovery entirely when configured, without touching the recommender', async () => {
    const h = harness({
      pool: bigLibrary(10),
      discoveries: manyDiscoveries(5),
      config: { interleave: { familiarRunMin: 2, familiarRunMax: 3, discoveryEnabled: false } },
    });
    const played = await playThrough(h, 4);
    expect(played.every((track) => track.autoplayKind === 'familiar')).toBe(true);
    expect(h.rank).not.toHaveBeenCalled();
  });

  it('serves only known songs when the discovery source is unavailable', async () => {
    const h = harness({ pool: bigLibrary(10), discoveries: [] });
    const played = await playThrough(h, 4);
    expect(played.length).toBe(8);
    expect(played.every((track) => track.autoplayKind === 'familiar')).toBe(true);
  });

  it("uses artist tags to keep a known song in the session's language ahead of one that is not", async () => {
    const pool = [
      familiar('Angrezi Band', 'Some Song', ['library']),
      familiar('Desi Band', 'Koi Gaana', ['library']),
    ];
    const h = harness({
      pool,
      artistTags: {
        'Angrezi Band': ['british', 'indie rock'],
        'Desi Band': ['bollywood', 'hindi'],
      },
    });
    const hindiSeeds: readonly TrackSeed[] = [{ title: 'तुम ही हो', artist: 'Arijit Singh' }];

    const generated = await h.planner.generate(ROOM, hindiSeeds, 1, { background: false });

    expect(generated[0]?.track.title).toBe('Koi Gaana');
  });

  it('releases every committed reservation when a later slot throws', async () => {
    const session = new AutoplaySessionStore();
    let calls = 0;
    const resolveKnown = vi.fn((_room: unknown, candidate: FamiliarCandidate) => {
      calls += 1;
      if (calls > 1) throw new Error('resolver exploded');
      return Promise.resolve(playable(candidate.artist, candidate.title));
    });
    const reserve = session.reserve.bind(session);
    let reserves = 0;
    vi.spyOn(session, 'reserve').mockImplementation((roomId, keys) => {
      reserves += 1;
      if (reserves === 2) return Promise.reject(new Error('redis down'));
      return reserve(roomId, keys);
    });
    const h = harness({ pool: bigLibrary(3), session, resolvers: { resolveKnown } });

    await expect(h.planner.generate(ROOM, seeds, 2, { background: false })).rejects.toThrow(
      /redis down/u,
    );

    expect((await session.snapshot(ROOM.roomId)).reservedKeys.size).toBe(0);
  });

  it('only refreshes listener profiles in the background', async () => {
    const session = new AutoplaySessionStore();
    await session.syncQueue(ROOM.roomId, [
      entryOf(playable('U', 'One'), { origin: 'user', requestedById: '111111111111111111' }),
    ]);
    const h = harness({ pool: bigLibrary(2), session });

    await h.planner.generate(ROOM, seeds, 1, { background: false });
    const foreground = h.profileOptions.find((call) => 'userId' in call.scope);
    expect(foreground?.options).toEqual({ allowRefresh: false });

    await h.planner.generate(ROOM, seeds, 1, { background: true });
    const background = h.profileOptions.filter((call) => 'userId' in call.scope).at(-1);
    expect(background?.options).toEqual({ allowRefresh: true });
  });

  it('throws before doing any work when the music layer has not attached resolvers', async () => {
    const planner = new AutoplayPlanner({
      session: new AutoplaySessionStore(),
      taste: {} as UserTasteService,
      familiar: {} as FamiliarPoolService,
      recommender: {} as RecommendationService,
    });
    await expect(planner.generate(ROOM, seeds, 1, { background: false })).rejects.toThrow(
      /resolvers/u,
    );
  });
});

describe('AutoplayPlanner — behavioural similarity and track profiles', () => {
  it('pulls forward the known song the room habitually plays right after the seed', async () => {
    const seedKey = identityOf('Seed Artist', 'Seed Song').key;
    const pool = [
      familiar('Artist Far', 'Unrelated', ['library']),
      familiar('Artist Near', 'Played Together', ['library']),
    ];
    const nearKey = identityOf('Artist Near', 'Played Together').key;
    const behaviour: CooccurrenceSignals = {
      tracks: new Map([[nearKey, new Map([[seedKey, 1]])]]),
      artists: new Map(),
    };
    const h = harness({ pool, behaviour });

    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });

    expect(generated[0]?.track.title).toBe('Played Together');
  });

  it('matches taste affinity through normalised genres, whatever the raw tag spelling', async () => {
    // The listener's profile learned "bollywood"; one candidate's artist is
    // tagged "hindi film songs", another "british indie". Only the normalised
    // genre key bridges the first spelling to the profile.
    const profile: TasteProfile = {
      ...EMPTY_TASTE_PROFILE,
      tagAffinity: { bollywood: 0.9, indian: 0.6 },
      confidence: 1,
      sampleSize: 100,
    };
    const tagsFor: Record<string, readonly string[]> = {
      'Desi Singer': ['hindi film songs', 'filmi'],
      'Indie Band': ['british', 'indie rock'],
    };
    const profiles = new TrackProfileResolver(
      { artistTags: (artist) => Promise.resolve(tagsFor[artist] ?? []) },
      new CacheService(),
    );
    const pool = [
      familiar('Indie Band', 'Grey Skies', ['library']),
      familiar('Desi Singer', 'Dil Ki Baat', ['library']),
    ];
    const h = harness({ pool, profile, profiles });

    const generated = await h.planner.generate(ROOM, seeds, 1, { background: false });

    expect(generated[0]?.track.title).toBe('Dil Ki Baat');
  });

  it('does not let a low-confidence language guess cost a song its place', async () => {
    // A Hindi session (Devanagari seed). One candidate is transliterated with
    // no tags at all — its language is unknown, not English — and must not be
    // penalised below an equally scored one.
    const hindiSeeds: readonly TrackSeed[] = [{ title: 'तुम ही हो', artist: 'Arijit Singh' }];
    const profiles = new TrackProfileResolver(
      { artistTags: () => Promise.resolve([]) },
      new CacheService(),
    );
    const pool = [
      familiar('Some Singer', 'Tum Mile', ['library']),
      familiar('Other Singer', 'Kabhi Kabhi', ['library']),
    ];
    const h = harness({ pool, profiles });

    const generated = await h.planner.generate(ROOM, hindiSeeds, 2, { background: false });

    expect(generated).toHaveLength(2);
  });
});

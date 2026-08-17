import { describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import { CacheService } from './cache.js';
import { trackKeyOf } from './identity.js';
import type { LastFmService, LastFmTag, SimilarArtist, SimilarTrack } from './lastfm.js';
import type { LLMProvider } from './llm/provider.js';
import { DEFAULT_TUNING, RecommendationService, type TrackResolver } from './recommender.js';
import { ShortlistReranker } from './rerank.js';
import type { Candidate } from './scoring.js';
import { EMPTY_RECENT_CONTEXT, EMPTY_TASTE_PROFILE } from './taste.js';

/**
 * A Last.fm stand-in that counts calls.
 *
 * The call counts are the point of most of these tests: the headline claim of
 * this pipeline is that a 300-track queue costs a handful of API calls rather
 * than hundreds, and only a counter can hold that claim honest.
 */
function fakeLastFm(options: { readonly catalogueSize?: number } = {}): {
  service: LastFmService;
  calls: {
    similarTracks: number;
    similarArtists: number;
    artistTags: number;
    tagTopTracks: number;
  };
} {
  const size = options.catalogueSize ?? 60;
  const calls = { similarTracks: 0, similarArtists: 0, artistTags: 0, tagTopTracks: 0 };

  const service = {
    enabled: true,
    similarTracks: vi.fn((artist: string): Promise<readonly SimilarTrack[]> => {
      calls.similarTracks += 1;
      return Promise.resolve(
        Array.from({ length: size }, (_, index) => ({
          name: `Track ${String(index)} of ${artist}`,
          // Twenty distinct artists keeps the pool diverse enough that the
          // per-artist cap is exercised rather than trivially satisfied.
          artist: `Artist ${String(index % 20)}`,
          match: 1 - index / size,
        })),
      );
    }),
    similarArtists: vi.fn((): Promise<readonly SimilarArtist[]> => {
      calls.similarArtists += 1;
      return Promise.resolve(
        Array.from({ length: 15 }, (_, index) => ({
          name: `Neighbour ${String(index)}`,
          match: 0.9 - index / 100,
        })),
      );
    }),
    artistTags: vi.fn((): Promise<readonly LastFmTag[]> => {
      calls.artistTags += 1;
      return Promise.resolve([
        { name: 'pop', count: 100 },
        { name: 'hindi', count: 80 },
      ]);
    }),
    trackTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
    tagTopTracks: vi.fn((tag: string): Promise<readonly SimilarTrack[]> => {
      calls.tagTopTracks += 1;
      return Promise.resolve(
        Array.from({ length: 40 }, (_, index) => ({
          name: `${tag} anthem ${String(index)}`,
          artist: `Tag Artist ${String(index % 10)}`,
          match: 0.5,
        })),
      );
    }),
  } as unknown as LastFmService;

  return { service, calls };
}

function track(candidate: Candidate, index: number): QueuedTrack {
  return {
    encoded: `enc-${String(index)}`,
    identifier: `id-${candidate.artist}-${candidate.title}`,
    title: candidate.title,
    author: candidate.artist,
    durationMs: 200_000,
    uri: `https://example.test/${String(index)}`,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: '0',
    requestedByName: 'Autoplay',
  };
}

/** A resolver that records peak concurrency so the bound can be asserted. */
function trackingResolver(): { resolve: TrackResolver; peakConcurrency: () => number } {
  let active = 0;
  let peak = 0;
  let index = 0;

  const resolve: TrackResolver = async (candidate) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, 1));
    active -= 1;
    return track(candidate, index++);
  };

  return { resolve, peakConcurrency: () => peak };
}

const baseRequest = {
  seeds: [{ title: 'Softly', artist: 'Karan Aujla' }],
  profile: EMPTY_TASTE_PROFILE,
  recent: EMPTY_RECENT_CONTEXT,
};

describe('RecommendationService', () => {
  it('returns the requested number of tracks', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend({ ...baseRequest, count: 10 }, resolve);

    expect(result.tracks).toHaveLength(10);
    expect(result.candidateCount).toBeGreaterThan(10);
  });

  // Requirement: a 300-song request must not be 300 sequential API calls.
  it('builds a 300-track queue from a bounded number of discovery calls', async () => {
    const { service, calls } = fakeLastFm({ catalogueSize: 400 });
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend({ ...baseRequest, count: 300 }, resolve);

    expect(result.tracks.length).toBeGreaterThan(100);

    // Similar-track calls: one per seed, plus a few per neighbouring artist.
    // The bound is what matters, not the exact figure.
    expect(calls.similarTracks).toBeLessThan(20);
    // Tag lookups are per distinct artist and capped, never per track.
    expect(calls.artistTags).toBeLessThanOrEqual(60);
  });

  it('scales discovery calls with seeds, not with the tracks requested', async () => {
    const cheap = fakeLastFm({ catalogueSize: 400 });
    const expensive = fakeLastFm({ catalogueSize: 400 });
    const { resolve } = trackingResolver();

    await new RecommendationService(cheap.service, new CacheService()).recommend(
      { ...baseRequest, count: 10 },
      resolve,
    );
    await new RecommendationService(expensive.service, new CacheService()).recommend(
      { ...baseRequest, count: 300 },
      resolve,
    );

    // Thirty times the tracks must not cost thirty times the discovery calls.
    expect(expensive.calls.similarTracks).toBe(cheap.calls.similarTracks);
    expect(expensive.calls.similarArtists).toBe(cheap.calls.similarArtists);
  });

  // Requirement: never bury the Lavalink node that is also streaming audio.
  it('bounds resolution concurrency', async () => {
    const { service } = fakeLastFm({ catalogueSize: 400 });
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve, peakConcurrency } = trackingResolver();

    await recommender.recommend({ ...baseRequest, count: 100 }, resolve);

    // The configured default is 8; anything at or below it proves the batching
    // is real rather than an unbounded Promise.all.
    expect(peakConcurrency()).toBeLessThanOrEqual(8);
    expect(peakConcurrency()).toBeGreaterThan(1);
  });

  it('never queues the same resolved upload twice', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    // Every candidate collapses to one upload — a real hazard when two Last.fm
    // spellings of a track resolve to the same YouTube video.
    const resolve: TrackResolver = async (candidate) =>
      Promise.resolve({ ...track(candidate, 0), identifier: 'same-upload' } as QueuedTrack);

    const result = await recommender.recommend({ ...baseRequest, count: 20 }, resolve);

    expect(result.tracks).toHaveLength(1);
  });

  it('survives a resolver that throws on some candidates', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    let index = 0;
    const resolve: TrackResolver = async (candidate) => {
      index += 1;
      if (index % 3 === 0) throw new Error('lavalink hiccup');
      return Promise.resolve(track(candidate, index));
    };

    const result = await recommender.recommend({ ...baseRequest, count: 12 }, resolve);

    expect(result.tracks.length).toBeGreaterThan(5);
    expect(result.tracks.length).toBeLessThan(12);
  });

  // Failsafe: no discovery source must not mean a thrown command.
  it('returns an empty result when Last.fm is unavailable', async () => {
    const disabled = { enabled: false } as unknown as LastFmService;
    const recommender = new RecommendationService(disabled, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend({ ...baseRequest, count: 10 }, resolve);

    expect(result.tracks).toHaveLength(0);
    expect(result.strategies).toContain('lastfm-disabled');
  });

  it('keeps excluded artists out of the pool entirely', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        ...baseRequest,
        count: 20,
        intent: {
          intent: 'recommend',
          query: null,
          mood: [],
          genre: [],
          activity: null,
          language: null,
          era: null,
          artists: [],
          excludeArtists: ['Artist 3'],
          quantity: 20,
          usePersonalHistory: true,
          avoidRecent: false,
          artistDiversity: true,
        },
      },
      resolve,
    );

    expect(result.picks.some((pick) => pick.artistKey === 'artist 3')).toBe(false);
  });

  it('reports per-stage timings', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend({ ...baseRequest, count: 5 }, resolve);

    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    for (const key of ['candidateMs', 'enrichMs', 'scoreMs', 'resolveMs'] as const) {
      expect(result.timings[key]).toBeGreaterThanOrEqual(0);
    }
  });
});

/** A Last.fm stand-in whose similarTracks call returns an exact, caller-chosen list. */
function fakeLastFmReturning(tracks: readonly SimilarTrack[]): LastFmService {
  return {
    enabled: true,
    similarTracks: vi.fn(() => Promise.resolve(tracks)),
    similarArtists: vi.fn(() => Promise.resolve([])),
    artistTags: vi.fn(() => Promise.resolve([])),
    trackTags: vi.fn(() => Promise.resolve([])),
    tagTopTracks: vi.fn(() => Promise.resolve([])),
  } as unknown as LastFmService;
}

// The bug these pin: exclusion used to be arbitrated by scoring (down-ranked,
// not removed), so a brilliant-but-excluded candidate could still slip through
// a thin pool. The exclusion layer now runs BEFORE scoring, at candidate
// generation, and is structural rather than statistical.
describe('RecommendationService — hard exclusions at candidate stage', () => {
  it('removes an excluded song before ranking, even when it would score highest', async () => {
    const tracks: SimilarTrack[] = [
      // The best-matching candidate by far — if exclusion were merely a
      // score penalty, this is exactly the track that would survive anyway.
      { name: 'Song One', artist: 'Artist A', match: 1 },
      ...Array.from({ length: 20 }, (_unused, index) => ({
        name: `Filler ${String(index)}`,
        artist: `Filler Artist ${String(index)}`,
        match: 0.5 - index / 100,
      })),
    ];
    const service = fakeLastFmReturning(tracks);
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [{ title: 'Seed Song', artist: 'Seed Artist' }],
        count: 5,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
        exclusions: {
          trackKeys: new Set([trackKeyOf('Artist A', 'Song One')]),
          identifiers: new Set(),
        },
      },
      resolve,
    );

    expect(result.tracks.some((entry) => entry.title === 'Song One')).toBe(false);
    expect(result.picks.some((pick) => pick.candidate.title === 'Song One')).toBe(false);
    expect(result.excludedCount).toBeGreaterThan(0);
  });

  // Seeds are never in the exclusion set explicitly — self-exclusion has to be
  // structural too, or "the song that is playing right now" becomes the most
  // jarring repeat autoplay can produce.
  it('never recommends the seed track itself, even with no exclusions supplied', async () => {
    const tracks: SimilarTrack[] = [
      { name: 'Seed Song', artist: 'Seed Artist', match: 1 },
      ...Array.from({ length: 20 }, (_unused, index) => ({
        name: `Filler ${String(index)}`,
        artist: `Filler Artist ${String(index)}`,
        match: 0.5 - index / 100,
      })),
    ];
    const service = fakeLastFmReturning(tracks);
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [{ title: 'Seed Song', artist: 'Seed Artist' }],
        count: 5,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
      },
      resolve,
    );

    expect(result.tracks.some((entry) => entry.title === 'Seed Song')).toBe(false);
    expect(result.picks.some((pick) => pick.candidate.title === 'Seed Song')).toBe(false);
  });
});

describe('RecommendationService — post-resolution blocking', () => {
  // Two different candidates can resolve to the same upload; the resolved
  // identity has to be checked AGAIN after resolution, not just at candidate
  // dedup, or the same video gets queued under two different Last.fm titles.
  it('collapses every candidate that resolves to the same upload into a single track', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const resolve: TrackResolver = async (candidate) =>
      Promise.resolve({ ...track(candidate, 0), identifier: 'dup1' } as QueuedTrack);

    const result = await recommender.recommend({ ...baseRequest, count: 10 }, resolve);

    expect(result.tracks).toHaveLength(1);
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);
  });

  // A resolved upload's identifier can turn out to already be excluded even
  // though the candidate that led to it looked fresh — the resolved identity
  // gets one more pass against `exclusions.identifiers`.
  it('blocks a resolved track whose identifier is in the exclusion set', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const resolve: TrackResolver = async (candidate) =>
      Promise.resolve({ ...track(candidate, 0), identifier: 'excluded-id' } as QueuedTrack);

    const result = await recommender.recommend(
      {
        ...baseRequest,
        count: 1,
        exclusions: { trackKeys: new Set(), identifiers: new Set(['excluded-id']) },
      },
      resolve,
    );

    expect(result.tracks).toHaveLength(0);
    expect(result.blockedCount).toBe(1);
  });
});

describe('RecommendationService — reservation filter', () => {
  // Reservation is what stops two concurrent generation passes queueing the
  // same song: a pick that loses the race must be dropped here, never
  // resolved and never queued.
  it('drops the highest-ranked pick when its reservation loses the race', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();
    let reservedKeys: readonly string[] = [];

    const result = await recommender.recommend(
      {
        ...baseRequest,
        count: 5,
        reserve: (keys) => {
          reservedKeys = keys;
          return Promise.resolve(new Set(keys.slice(1)));
        },
      },
      resolve,
    );

    expect(reservedKeys.length).toBeGreaterThan(1);
    expect(result.resolved.some((entry) => entry.trackKey === reservedKeys[0])).toBe(false);
    for (const entry of result.resolved) {
      expect(reservedKeys.slice(1)).toContain(entry.trackKey);
    }
  });

  it('resolves nothing and never calls the resolver when reservation grants nothing', async () => {
    const { service } = fakeLastFm();
    const recommender = new RecommendationService(service, new CacheService());
    let resolveCalls = 0;
    const resolve: TrackResolver = (candidate) => {
      resolveCalls += 1;
      return Promise.resolve(track(candidate, resolveCalls));
    };

    const result = await recommender.recommend(
      { ...baseRequest, count: 5, reserve: () => Promise.resolve(new Set<string>()) },
      resolve,
    );

    expect(result.tracks).toHaveLength(0);
    expect(resolveCalls).toBe(0);
  });
});

describe('RecommendationService — multi-source candidate generation', () => {
  function fakeLastFmMultiSource(): {
    service: LastFmService;
    calls: { artistTopTracks: number; similarArtists: number };
  } {
    const calls = { artistTopTracks: 0, similarArtists: 0 };
    const service = {
      enabled: true,
      similarTracks: vi.fn((artist: string): Promise<readonly SimilarTrack[]> =>
        Promise.resolve(
          Array.from({ length: 20 }, (_unused, index) => ({
            name: `Similar ${String(index)} of ${artist}`,
            artist: `Similar Artist ${String(index)}`,
            match: 1 - index / 20,
          })),
        ),
      ),
      similarArtists: vi.fn((): Promise<readonly SimilarArtist[]> => {
        calls.similarArtists += 1;
        return Promise.resolve(
          Array.from({ length: 10 }, (_unused, index) => ({
            name: `Neighbour ${String(index)}`,
            match: 0.8 - index / 50,
          })),
        );
      }),
      artistTopTracks: vi.fn((artist: string): Promise<readonly SimilarTrack[]> => {
        calls.artistTopTracks += 1;
        return Promise.resolve(
          Array.from({ length: 12 }, (_unused, index) => ({
            name: `${artist} Hit ${String(index)}`,
            artist,
            match: 0.9 - index / 20,
          })),
        );
      }),
      artistTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      trackTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      tagTopTracks: vi.fn((): Promise<readonly SimilarTrack[]> => Promise.resolve([])),
    } as unknown as LastFmService;
    return { service, calls };
  }

  // The taste profile is a candidate SOURCE, not just a re-ranker — without
  // this, autoplay orbits whatever happens to be playing (pure seed
  // similarity) instead of the person listening.
  it('pulls candidates from the taste profile, not only from seed similarity', async () => {
    const { service, calls } = fakeLastFmMultiSource();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();
    const profile = {
      ...EMPTY_TASTE_PROFILE,
      artistAffinity: { 'artist one': 0.9, 'artist two': 0.5 },
    };

    const result = await recommender.recommend(
      { seeds: baseRequest.seeds, count: 10, profile, recent: EMPTY_RECENT_CONTEXT },
      resolve,
    );

    expect(calls.artistTopTracks).toBeGreaterThan(0);
    expect(result.strategies).toContain('taste-artists');
    expect(result.strategies).toContain('discovery');
  });

  // This is what decouples autoplay from current-song similarity: with zero
  // seeds there is nothing to expand from except the listener's own taste, and
  // the pipeline still has to produce a real pool from that alone.
  it('still produces candidates with no seeds at all, from taste sources alone', async () => {
    const { service } = fakeLastFmMultiSource();
    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();
    const profile = {
      ...EMPTY_TASTE_PROFILE,
      artistAffinity: { 'artist one': 0.9, 'artist two': 0.5 },
    };

    const result = await recommender.recommend(
      { seeds: [], count: 10, profile, recent: EMPTY_RECENT_CONTEXT },
      resolve,
    );

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(result.tracks.length).toBeGreaterThan(0);
  });
});

describe('RecommendationService — rerank safety', () => {
  function fakeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
    return { name: 'test', available: true, complete: vi.fn(), ...overrides };
  }

  it('applies a valid rerank permutation without changing which songs were picked', async () => {
    const { service } = fakeLastFm();
    // The shortlist floor is 40 and only the first 30 are shown to the model
    // (MAX_CANDIDATES_SENT); a reversed full-head order is trivially "valid"
    // and exercises real reordering rather than a no-op.
    const order = Array.from({ length: 30 }, (_unused, index) => 29 - index);
    const provider = fakeProvider({
      complete: vi
        .fn()
        .mockResolvedValue({ text: JSON.stringify({ order }), model: 'test', latencyMs: 1 }),
    });
    const reranker = new ShortlistReranker(provider);
    const recommender = new RecommendationService(
      service,
      new CacheService(),
      DEFAULT_TUNING,
      reranker,
    );
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      { ...baseRequest, count: 6, allowRerank: true },
      resolve,
    );

    expect(result.reranked).toBe(true);
    expect(result.tracks).toHaveLength(6);
    // Reordering must never duplicate or invent a pick — the model only ever
    // sees indices into an already-filtered, already-scored shortlist.
    const pickedTitles = result.picks.map((pick) => pick.candidate.title);
    expect(new Set(pickedTitles).size).toBe(pickedTitles.length);
  });

  // The response format has no room for anything but an index, so a hard
  // exclusion made upstream of the rerank call structurally cannot be undone
  // by it — this pins that guarantee end to end, rerank pass included.
  it('keeps a hard-excluded song out even when the reranker is active', async () => {
    const excludedKey = trackKeyOf('Artist A', 'Song One');
    const tracks: SimilarTrack[] = [
      { name: 'Song One', artist: 'Artist A', match: 1 },
      ...Array.from({ length: 20 }, (_unused, index) => ({
        name: `Filler ${String(index)}`,
        artist: `Filler Artist ${String(index)}`,
        match: 0.9 - index / 30,
      })),
    ];
    const service = fakeLastFmReturning(tracks);
    const order = Array.from({ length: 20 }, (_unused, index) => 19 - index);
    const provider = fakeProvider({
      complete: vi
        .fn()
        .mockResolvedValue({ text: JSON.stringify({ order }), model: 'test', latencyMs: 1 }),
    });
    const reranker = new ShortlistReranker(provider);
    const recommender = new RecommendationService(
      service,
      new CacheService(),
      DEFAULT_TUNING,
      reranker,
    );
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [{ title: 'Seed Song', artist: 'Seed Artist' }],
        count: 5,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
        exclusions: { trackKeys: new Set([excludedKey]), identifiers: new Set() },
        allowRerank: true,
      },
      resolve,
    );

    expect(result.tracks.some((entry) => entry.title === 'Song One')).toBe(false);
  });

  it('falls back to the deterministic ranking when the provider throws', async () => {
    const { service } = fakeLastFm();
    const provider = fakeProvider({
      complete: vi.fn().mockRejectedValue(new Error('provider exploded')),
    });
    const reranker = new ShortlistReranker(provider);
    const recommender = new RecommendationService(
      service,
      new CacheService(),
      DEFAULT_TUNING,
      reranker,
    );
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      { ...baseRequest, count: 5, allowRerank: true },
      resolve,
    );

    expect(result.reranked).toBe(false);
    expect(result.tracks.length).toBeGreaterThan(0);
  });

  // The complaint behind this test: play a Hindi song in a guild whose history
  // is mostly English, start autoplay, get English songs. The seed's language
  // must decide the session's language — and a candidate confidently tagged as
  // another language must never surface, even when raw similarity favours it.
  it('keeps a Hindi session Hindi even when English candidates outscore on similarity', async () => {
    const tagsByArtist: Record<string, readonly string[]> = {
      'Arijit Singh': ['bollywood', 'romantic'],
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `Desi Artist ${String(index)}`,
          ['hindi', 'filmi'],
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `English Artist ${String(index)}`,
          ['british', 'pop'],
        ]),
      ),
    };

    const service = {
      enabled: true,
      similarTracks: vi.fn((): Promise<readonly SimilarTrack[]> =>
        Promise.resolve([
          // English candidates get PERFECT similarity; Hindi ones middling.
          // Ranking alone would put every English track first.
          ...Array.from({ length: 20 }, (_, index) => ({
            name: `English Hit ${String(index)}`,
            artist: `English Artist ${String(index % 5)}`,
            match: 1,
          })),
          ...Array.from({ length: 20 }, (_, index) => ({
            name: `Hindi Song ${String(index)}`,
            artist: `Desi Artist ${String(index % 5)}`,
            match: 0.6,
          })),
        ]),
      ),
      similarArtists: vi.fn((): Promise<readonly SimilarArtist[]> => Promise.resolve([])),
      artistTags: vi.fn((artist: string): Promise<readonly LastFmTag[]> =>
        Promise.resolve((tagsByArtist[artist] ?? []).map((name) => ({ name, count: 10 }))),
      ),
      trackTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      tagTopTracks: vi.fn((): Promise<readonly SimilarTrack[]> => Promise.resolve([])),
    } as unknown as LastFmService;

    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [{ title: 'Tum Hi Ho', artist: 'Arijit Singh' }],
        count: 6,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
      },
      resolve,
    );

    expect(result.tracks.length).toBeGreaterThan(0);
    for (const entry of result.tracks) {
      expect(entry.author).toMatch(/^Desi Artist/);
    }
  });

  // Anti-drift at the candidate level: a low-weight autoplay context seed may
  // contribute candidates, but its neighbourhood must rank below the anchors'
  // and must never drive the similar-artist expansion.
  it('lets anchor seeds dominate a low-weight autoplay context seed', async () => {
    const similarArtists = vi.fn((_artist: string): Promise<readonly SimilarArtist[]> =>
      Promise.resolve([]),
    );
    const service = {
      enabled: true,
      similarTracks: vi.fn((artist: string): Promise<readonly SimilarTrack[]> =>
        Promise.resolve(
          Array.from({ length: 8 }, (_, index) => ({
            name: `${artist} Neighbour Song ${String(index)}`,
            artist: `${artist} Neighbour ${String(index)}`,
            match: 1,
          })),
        ),
      ),
      similarArtists,
      artistTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      trackTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      tagTopTracks: vi.fn((): Promise<readonly SimilarTrack[]> => Promise.resolve([])),
    } as unknown as LastFmService;

    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [
          { title: 'Anchor Song', artist: 'Anchor' },
          { title: 'Drift Song', artist: 'Drift', weight: 0.4 },
        ],
        count: 4,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
      },
      resolve,
    );

    // Every pick comes from the anchor's neighbourhood — identical raw match,
    // but the context seed's candidates carry a discounted score.
    expect(result.tracks.length).toBeGreaterThan(0);
    for (const track of result.tracks) {
      expect(track.author.startsWith('Anchor')).toBe(true);
    }

    // Artist-neighbourhood expansion never runs from the autoplay seed.
    for (const call of similarArtists.mock.calls) {
      expect(call[0]).toBe('Anchor');
    }
  });

  it('reads the session language off a native-script title without any tag lookup', async () => {
    const service = {
      enabled: true,
      similarTracks: vi.fn((): Promise<readonly SimilarTrack[]> =>
        Promise.resolve([
          ...Array.from({ length: 10 }, (_, index) => ({
            name: `English Hit ${String(index)}`,
            artist: `English Artist ${String(index % 5)}`,
            match: 1,
          })),
          ...Array.from({ length: 10 }, (_, index) => ({
            name: `Hindi Song ${String(index)}`,
            artist: `Desi Artist ${String(index % 5)}`,
            match: 0.6,
          })),
        ]),
      ),
      similarArtists: vi.fn((): Promise<readonly SimilarArtist[]> => Promise.resolve([])),
      // Tags identify candidate languages but say nothing about the seed —
      // the Devanagari title alone must establish the session as Hindi.
      artistTags: vi.fn((artist: string): Promise<readonly LastFmTag[]> =>
        Promise.resolve(
          artist.startsWith('English')
            ? [{ name: 'british', count: 10 }]
            : artist.startsWith('Desi')
              ? [{ name: 'bollywood', count: 10 }]
              : [],
        ),
      ),
      trackTags: vi.fn((): Promise<readonly LastFmTag[]> => Promise.resolve([])),
      tagTopTracks: vi.fn((): Promise<readonly SimilarTrack[]> => Promise.resolve([])),
    } as unknown as LastFmService;

    const recommender = new RecommendationService(service, new CacheService());
    const { resolve } = trackingResolver();

    const result = await recommender.recommend(
      {
        seeds: [{ title: 'तुम ही हो', artist: 'Arijit Singh' }],
        count: 4,
        profile: EMPTY_TASTE_PROFILE,
        recent: EMPTY_RECENT_CONTEXT,
      },
      resolve,
    );

    expect(result.tracks.length).toBeGreaterThan(0);
    for (const entry of result.tracks) {
      expect(entry.author).toMatch(/^Desi Artist/);
    }
  });
});

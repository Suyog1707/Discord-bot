import { describe, expect, it, vi } from 'vitest';

import type { QueuedTrack } from '../music/track.js';

import { CacheService } from './cache.js';
import type { LastFmService, LastFmTag, SimilarArtist, SimilarTrack } from './lastfm.js';
import { RecommendationService, type TrackResolver } from './recommender.js';
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

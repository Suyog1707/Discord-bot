import { describe, expect, it, vi } from 'vitest';

import { CacheService } from './cache.js';
import { releaseYearOf, type TagSource, TrackProfileResolver } from './track-profile.js';

/** A `TagSource` that records what it was asked, with no network anywhere. */
function fakeTags(tags: readonly string[] = [], country: string | null = null) {
  const artistTags = vi.fn(() => Promise.resolve(tags));
  const artistCountry = vi.fn(() => Promise.resolve(country));
  const source: TagSource = { artistTags, artistCountry };
  return { source, artistTags, artistCountry };
}

const SONG = { title: 'Kesariya', artist: 'Arijit Singh' };

describe('TrackProfileResolver.fromMetadata', () => {
  // The whole point of the static entry point: it is safe on the hot path
  // because it cannot reach the network, and that has to stay true.
  it('never touches the tag source', () => {
    const { source, artistTags, artistCountry } = fakeTags(['bollywood']);
    new TrackProfileResolver(source, new CacheService());

    const profile = TrackProfileResolver.fromMetadata({ ...SONG, tags: ['Bollywood'] });

    expect(artistTags).not.toHaveBeenCalled();
    expect(artistCountry).not.toHaveBeenCalled();
    expect(profile.genres).toEqual(['bollywood']);
    expect(profile.families).toEqual(['indian']);
  });

  it('carries the canonical identity the rest of the stack keys on', () => {
    const profile = TrackProfileResolver.fromMetadata({
      title: 'Blinding Lights (Official Video)',
      artist: 'The Weeknd',
      artists: ['The Weeknd'],
      album: ' After Hours ',
      durationMs: 200_040.6,
      isrc: ' uscA22000010 ',
      releaseDate: '2019-11-29',
      provider: 'spotify',
    });

    expect(profile.key).toBe('weeknd::blinding lights');
    expect(profile.artistKey).toBe('weeknd');
    expect(profile.title).toBe('Blinding Lights (Official Video)');
    expect(profile.artists).toEqual(['The Weeknd']);
    expect(profile.album).toBe('After Hours');
    expect(profile.durationMs).toBe(200_041);
    expect(profile.isrc).toBe('USCA22000010');
    expect(profile.releaseYear).toBe(2019);
    expect(profile.provider).toBe('spotify');
  });

  // With no tags at all the writing system is the only signal — and it is a
  // free one, available before any lookup.
  it('falls back to the title script for language', () => {
    const profile = TrackProfileResolver.fromMetadata({
      title: 'तुम ही हो',
      artist: 'Arijit Singh',
    });

    expect(profile.language).toEqual({ value: 'hindi', confidence: 'medium', source: 'script' });
  });

  it('prefers an explicit provider language', () => {
    const profile = TrackProfileResolver.fromMetadata({
      ...SONG,
      providerLanguage: 'hi',
      tags: ['british'],
    });

    expect(profile.language).toEqual({ value: 'hindi', confidence: 'high', source: 'provider' });
  });

  it('yields a usable profile when everything is missing', () => {
    const profile = TrackProfileResolver.fromMetadata({ title: '', artist: '' });

    expect(profile.language).toEqual({ value: null, confidence: 'none', source: 'none' });
    expect(profile.genres).toEqual([]);
    expect(profile.families).toEqual([]);
    expect(profile.styles).toEqual([]);
    expect(profile.rawTags).toEqual([]);
    expect(profile.artists).toEqual([]);
    expect(profile.album).toBeNull();
    expect(profile.isrc).toBeNull();
    expect(profile.releaseYear).toBeNull();
    expect(profile.provider).toBeNull();
    expect(profile.durationMs).toBe(0);
  });
});

describe('TrackProfileResolver.resolve', () => {
  it('enriches from the tag source and folds the result', async () => {
    const { source, artistTags, artistCountry } = fakeTags(['Bollywood', 'seen live'], 'IN');
    const resolver = new TrackProfileResolver(source, new CacheService());

    const profile = await resolver.resolve(SONG);

    expect(artistTags).toHaveBeenCalledWith('Arijit Singh');
    expect(artistCountry).toHaveBeenCalledWith('Arijit Singh');
    expect(profile.rawTags).toEqual(['bollywood', 'seen live']);
    expect(profile.genres).toEqual(['bollywood']);
    expect(profile.styles).toEqual([]);
    expect(profile.language).toEqual({ value: 'hindi', confidence: 'high', source: 'tags' });
  });

  // Artist facts do not change, and the lookup is the expensive part; a second
  // pass over the same track in the same autoplay refill must be free.
  it('looks the artist up once and serves the rest from cache', async () => {
    const { source, artistTags } = fakeTags(['bollywood']);
    const resolver = new TrackProfileResolver(source, new CacheService());

    const first = await resolver.resolve(SONG);
    const second = await resolver.resolve(SONG);

    expect(artistTags).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('uses the artist country when tags say nothing', async () => {
    const { source } = fakeTags([], 'KR');
    const resolver = new TrackProfileResolver(source, new CacheService());

    const profile = await resolver.resolve({ title: 'Ditto', artist: 'NewJeans' });

    expect(profile.language).toEqual({ value: 'korean', confidence: 'medium', source: 'artist' });
  });

  // A Last.fm outage must not stop the music: enrichment is an improvement,
  // never a requirement.
  it('degrades to metadata when the tag source fails', async () => {
    const source: TagSource = {
      artistTags: () => Promise.reject(new Error('last.fm down')),
      artistCountry: () => Promise.reject(new Error('musicbrainz down')),
    };
    const resolver = new TrackProfileResolver(source, new CacheService());

    const profile = await resolver.resolve({ ...SONG, tags: ['bollywood'] });

    expect(profile.genres).toEqual(['bollywood']);
    expect(profile.rawTags).toEqual(['bollywood']);
  });

  it('works with a tag source that has no country lookup', async () => {
    const artistTags = vi.fn(() => Promise.resolve(['punjabi']));
    const resolver = new TrackProfileResolver({ artistTags }, new CacheService());

    const profile = await resolver.resolve({ title: 'Excuses', artist: 'AP Dhillon' });

    expect(profile.genres).toEqual(['punjabi']);
    expect(profile.language.value).toBe('punjabi');
  });
});

describe('releaseYearOf', () => {
  it('reads the year out of every shape a provider sends', () => {
    expect(releaseYearOf('2019-05-03')).toBe(2019);
    expect(releaseYearOf('2019')).toBe(2019);
    expect(releaseYearOf('2019-05')).toBe(2019);
    expect(releaseYearOf(' 1975 ')).toBe(1975);
  });

  // A wrong year is worse than no year — it feeds "more from this era".
  it('rejects junk rather than coercing it', () => {
    expect(releaseYearOf('unknown')).toBeNull();
    expect(releaseYearOf('99')).toBeNull();
    expect(releaseYearOf('')).toBeNull();
    expect(releaseYearOf(null)).toBeNull();
    expect(releaseYearOf(undefined)).toBeNull();
  });
});

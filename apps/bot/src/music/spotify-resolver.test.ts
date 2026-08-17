import { describe, expect, it } from 'vitest';

import { pickBestSpotifyResult, type SpotifySearchPage } from './spotify-resolver.js';

const url = (kind: string, id: string): string => `https://open.spotify.com/${kind}/${id}`;

function track(name: string, artists: readonly string[], popularity: number, id: string) {
  return {
    name,
    artists: artists.map((artist) => ({ name: artist })),
    popularity,
    external_urls: { spotify: url('track', id) },
  };
}

function album(name: string, artists: readonly string[], albumType: string, id: string) {
  return {
    name,
    artists: artists.map((artist) => ({ name: artist })),
    album_type: albumType,
    external_urls: { spotify: url('album', id) },
  };
}

function artist(name: string, popularity: number, id: string) {
  return { name, popularity, external_urls: { spotify: url('artist', id) } };
}

function playlist(name: string, id: string) {
  return { name, external_urls: { spotify: url('playlist', id) } };
}

describe('pickBestSpotifyResult', () => {
  // The headline requirement: "/play Parwana" must be able to find the ALBUM
  // named Parwana, even though tracks of that name are individually popular.
  it('prefers an exactly-named full album over an exactly-named track', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [track('Parwana', ['Aditya Rikhari'], 80, 't1')] },
      albums: { items: [album('Parwana', ['Aditya Rikhari'], 'album', 'a1')] },
    };

    const best = pickBestSpotifyResult('Parwana', page);
    expect(best?.kind).toBe('album');
    expect(best?.url).toBe(url('album', 'a1'));
  });

  it('does not let a single/EP outrank the exactly-named track', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [track('Husn', ['Anuv Jain'], 85, 't1')] },
      albums: { items: [album('Husn', ['Anuv Jain'], 'single', 'a1')] },
    };

    expect(pickBestSpotifyResult('Husn', page)?.kind).toBe('track');
  });

  // "/play Parwana Arijit Singh" — both words groups must count: the track
  // whose title AND artist cover the query beats an exact-name album by
  // somebody else.
  it('prioritises title + artist matches over a name-only match', () => {
    const page: SpotifySearchPage = {
      tracks: {
        items: [
          track('Parwana', ['Arijit Singh'], 60, 't1'),
          track('Parwana', ['Aditya Rikhari'], 90, 't2'),
        ],
      },
      albums: { items: [album('Parwana', ['Aditya Rikhari'], 'album', 'a1')] },
    };

    const best = pickBestSpotifyResult('Parwana Arijit Singh', page);
    expect(best?.url).toBe(url('track', 't1'));
  });

  it('resolves a bare artist name to the artist', () => {
    const page: SpotifySearchPage = {
      artists: { items: [artist('Arijit Singh', 92, 'ar1')] },
      playlists: { items: [playlist('Arijit Singh', 'p1')] },
      tracks: { items: [track('Tum Hi Ho', ['Arijit Singh'], 88, 't1')] },
    };

    expect(pickBestSpotifyResult('Arijit Singh', page)?.kind).toBe('artist');
  });

  it('breaks exact-match ties by popularity', () => {
    const page: SpotifySearchPage = {
      tracks: {
        items: [
          track('Believer', ['Copycat Covers'], 10, 't-cover'),
          track('Believer', ['Imagine Dragons'], 95, 't-real'),
        ],
      },
    };

    expect(pickBestSpotifyResult('Believer', page)?.url).toBe(url('track', 't-real'));
  });

  it('accepts a strong textual match when nothing is exact', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [track('Shape of You', ['Ed Sheeran'], 90, 't1')] },
    };

    expect(pickBestSpotifyResult('shape of you ed sheeran', page)?.url).toBe(url('track', 't1'));
  });

  it('lets a playlist win only when nothing better matches', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [track('Completely Different Song', ['Someone'], 90, 't1')] },
      playlists: { items: [playlist('lofi beats to study to', 'p1')] },
    };

    expect(pickBestSpotifyResult('lofi beats to study to', page)?.kind).toBe('playlist');
  });

  // Returning null is what hands the query to the provider-search fallback —
  // a bad guess here would hijack every query Spotify has no answer for.
  it('returns null when no result credibly matches', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [track('Unrelated Anthem', ['Somebody'], 99, 't1')] },
      playlists: { items: [playlist('Random Mix', 'p1')] },
    };

    expect(pickBestSpotifyResult('zxqv wmbtl kkjhg', page)).toBeNull();
  });

  it('tolerates null rows and missing sections', () => {
    const page: SpotifySearchPage = {
      tracks: { items: [null, track('Parwana', ['Aditya Rikhari'], 50, 't1')] },
      playlists: { items: [null] },
    };

    expect(pickBestSpotifyResult('Parwana', page)?.url).toBe(url('track', 't1'));
  });
});

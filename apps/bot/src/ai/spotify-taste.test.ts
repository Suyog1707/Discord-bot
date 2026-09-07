/**
 * The Spotify taste source.
 *
 * Two properties matter more than the mapping itself: it never blocks a queue
 * refill (a cold cache yields nothing and warms in the background), and it
 * never throws (an unreachable Spotify has to degrade autoplay to its old
 * behaviour, not break it).
 */
import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@discord-music/database';

import type { SpotifyService } from '../services/spotify-service.js';

import { CacheService } from './cache.js';
import { SpotifyTasteService } from './spotify-taste.js';

function makeSpotify(overrides: Record<string, unknown> = {}): SpotifyService {
  return {
    canReadTokens: () => true,
    listPlaylists: vi.fn(() => Promise.resolve([{ spotifyId: 'p1', name: 'Mine', trackCount: 2 }])),
    playlistTracks: vi.fn(() =>
      Promise.resolve([
        {
          title: 'Kesariya',
          artist: 'Arijit Singh',
          durationMs: 240_000,
          uri: 'https://open.spotify.com/track/t1',
          spotifyId: 't1',
          artworkUrl: null,
        },
        {
          title: 'Tum Hi Ho',
          artist: 'Arijit Singh',
          durationMs: 260_000,
          uri: null,
          spotifyId: 't2',
          artworkUrl: null,
        },
      ]),
    ),
    ...overrides,
  } as unknown as SpotifyService;
}

function makePrisma(optIn = true): PrismaClient {
  return {
    spotifyAccount: { findFirst: vi.fn(() => Promise.resolve({ autoplayOptIn: optIn })) },
  } as unknown as PrismaClient;
}

function makeService(
  options: { spotify?: SpotifyService; prisma?: PrismaClient; enabled?: boolean } = {},
): SpotifyTasteService {
  return new SpotifyTasteService({
    spotify: options.spotify ?? makeSpotify(),
    cache: new CacheService(),
    prisma: options.prisma ?? makePrisma(),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

/** The background warm-up is fire-and-forget; let its microtasks drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('tracksFor', () => {
  /** The critical-path rule: a cold listener costs the caller nothing. */
  it('returns nothing on a cold cache rather than waiting on Spotify', async () => {
    const service = makeService();

    await expect(service.tracksFor(['user-1'])).resolves.toEqual([]);
  });

  it('serves the library once the background warm-up has landed', async () => {
    const service = makeService();

    await service.tracksFor(['user-1']);
    await settle();
    const tracks = await service.tracksFor(['user-1']);

    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      title: 'Kesariya',
      author: 'Arijit Singh',
      identifier: 'spotify:track:t1',
      source: 'SPOTIFY',
      ownerId: 'user-1',
    });
  });

  it('reads nothing for a listener who opted out of steering the room', async () => {
    const service = makeService({ prisma: makePrisma(false) });

    await service.tracksFor(['user-1']);
    await settle();

    await expect(service.tracksFor(['user-1'])).resolves.toEqual([]);
  });

  it('is a no-op when the feature is switched off', async () => {
    const listPlaylists = vi.fn(() => Promise.resolve([]));
    const spotify = makeSpotify({ listPlaylists });
    const service = makeService({ spotify, enabled: false });

    await expect(service.tracksFor(['user-1'])).resolves.toEqual([]);
    await settle();
    expect(listPlaylists).not.toHaveBeenCalled();
  });

  /** An unreachable Spotify must never take autoplay down with it. */
  it('swallows an API failure and stays empty', async () => {
    const spotify = makeSpotify({
      listPlaylists: vi.fn(() => Promise.reject(new Error('spotify down'))),
    });
    const service = makeService({ spotify });

    await expect(service.tracksFor(['user-1'])).resolves.toEqual([]);
    await settle();
    await expect(service.tracksFor(['user-1'])).resolves.toEqual([]);
  });

  /** One unreadable playlist is not the whole library. */
  it('skips a playlist it cannot read', async () => {
    const spotify = makeSpotify({
      listPlaylists: vi.fn(() =>
        Promise.resolve([
          { spotifyId: 'bad', name: 'Gone', trackCount: 0 },
          { spotifyId: 'p1', name: 'Mine', trackCount: 1 },
        ]),
      ),
      playlistTracks: vi.fn((_id: string, playlistId: string) =>
        playlistId === 'bad'
          ? Promise.reject(new Error('403'))
          : Promise.resolve([
              {
                title: 'Kesariya',
                artist: 'Arijit Singh',
                durationMs: 240_000,
                uri: null,
                spotifyId: 't1',
                artworkUrl: null,
              },
            ]),
      ),
    });
    const service = makeService({ spotify });

    await service.tracksFor(['user-1']);
    await settle();

    expect(await service.tracksFor(['user-1'])).toHaveLength(1);
  });

  /** The same song on three of their playlists is one statement of taste. */
  it('folds duplicates onto one canonical entry', async () => {
    const track = {
      title: 'Kesariya',
      artist: 'Arijit Singh',
      durationMs: 240_000,
      uri: null,
      spotifyId: 't1',
      artworkUrl: null,
    };
    const spotify = makeSpotify({
      listPlaylists: vi.fn(() =>
        Promise.resolve([
          { spotifyId: 'p1', name: 'A', trackCount: 1 },
          { spotifyId: 'p2', name: 'B', trackCount: 1 },
        ]),
      ),
      // Same song, spelled differently — the canonical key has to see through it.
      playlistTracks: vi.fn(() => Promise.resolve([track, { ...track, title: 'KESARIYA ' }])),
    });
    const service = makeService({ spotify });

    await service.tracksFor(['user-1']);
    await settle();

    expect(await service.tracksFor(['user-1'])).toHaveLength(1);
  });

  it('blends every listener in the room', async () => {
    const service = makeService();

    await service.tracksFor(['user-1', 'user-2']);
    await settle();
    const tracks = await service.tracksFor(['user-1', 'user-2']);

    expect(tracks).toHaveLength(4);
    expect(new Set(tracks.map((track) => track.ownerId))).toEqual(new Set(['user-1', 'user-2']));
  });
});

describe('artistAffinity', () => {
  it('normalises the most-saved artist to 1', async () => {
    const service = makeService();

    await service.tracksFor(['user-1']);
    await settle();
    const affinity = await service.artistAffinity(['user-1']);

    // Both tracks are the same artist, so that artist is the peak.
    expect([...affinity.values()]).toEqual([1]);
  });

  it('is empty when nothing is known', async () => {
    const service = makeService();

    expect((await service.artistAffinity(['user-1'])).size).toBe(0);
  });
});

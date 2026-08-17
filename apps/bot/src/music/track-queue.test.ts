import { describe, expect, it } from 'vitest';

import {
  buildSearchQuery,
  formatTrackDuration,
  mapSource,
  trackLink,
  type QueuedTrack,
} from './track.js';
import { QueueFullError, TrackQueue } from './track-queue.js';

function makeTrack(id: string, overrides: Partial<QueuedTrack> = {}): QueuedTrack {
  return {
    encoded: `encoded-${id}`,
    identifier: id,
    title: `Track ${id}`,
    author: 'Artist',
    durationMs: 180_000,
    uri: `https://example.com/${id}`,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: 'user-1',
    requestedByName: 'User',
    ...overrides,
  };
}

function tracks(...ids: string[]): QueuedTrack[] {
  return ids.map((id) => makeTrack(id));
}

function autoplayTrack(id: string): QueuedTrack {
  return makeTrack(id, { origin: 'autoplay', requestedByName: 'Autoplay' });
}

describe('TrackQueue', () => {
  describe('add', () => {
    it('appends and reports the insert position', () => {
      const queue = new TrackQueue();
      expect(queue.add(tracks('a', 'b'))).toBe(0);
      expect(queue.add(tracks('c'))).toBe(2);
      expect(queue.size).toBe(3);
    });

    // The explicit user queue always outranks pending autoplay: with E/F
    // waiting from the radio, a user queueing D/X must hear D/X first.
    it('inserts user tracks before pending autoplay tracks', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a'));
      queue.advance(); // playing 'a'
      queue.add([autoplayTrack('e'), autoplayTrack('f')]);

      const position = queue.add(tracks('d', 'x'));

      expect(position).toBe(1);
      expect(queue.upcoming.map((track) => track.identifier)).toEqual(['d', 'x', 'e', 'f']);
    });

    it('does not interrupt an autoplay track that is already playing', () => {
      const queue = new TrackQueue();
      queue.add([autoplayTrack('e'), autoplayTrack('f')]);
      queue.advance(); // playing autoplay 'e'

      queue.add(tracks('d'));

      expect(queue.current?.identifier).toBe('e');
      expect(queue.upcoming.map((track) => track.identifier)).toEqual(['d', 'f']);
    });

    it('appends autoplay batches at the end, never ahead of user tracks', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.advance();

      queue.add([autoplayTrack('e')]);

      expect(queue.upcoming.map((track) => track.identifier)).toEqual(['b', 'e']);
    });

    it('inserts after the current track with next: true', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b', 'c'));
      queue.advance(); // now playing 'a'

      queue.add(tracks('x'), { next: true });

      expect(queue.tracks.map((t) => t.identifier)).toEqual(['a', 'x', 'b', 'c']);
    });

    it('appends when nothing has started even with next: true', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a'));
      queue.add(tracks('x'), { next: true });
      expect(queue.tracks.map((t) => t.identifier)).toEqual(['a', 'x']);
    });

    it('rejects a batch that would exceed capacity', () => {
      const queue = new TrackQueue(2);
      queue.add(tracks('a', 'b'));
      expect(() => queue.add(tracks('c'))).toThrow(QueueFullError);
    });
  });

  describe('advance (natural end)', () => {
    it('walks the queue in order and returns null when drained', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));

      expect(queue.advance()?.identifier).toBe('a');
      expect(queue.advance()?.identifier).toBe('b');
      expect(queue.advance()).toBeNull();
      expect(queue.upcoming).toHaveLength(0);
    });

    it('repeats the current track under track loop', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.advance();
      queue.loopMode = 'track';

      expect(queue.advance()?.identifier).toBe('a');
      expect(queue.advance()?.identifier).toBe('a');
    });

    it('wraps to the start under queue loop', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.loopMode = 'queue';

      queue.advance(); // a
      queue.advance(); // b
      expect(queue.advance()?.identifier).toBe('a');
    });
  });

  describe('skip (user action)', () => {
    it('ignores track loop — a skip must never replay the same track', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.advance();
      queue.loopMode = 'track';

      expect(queue.skip()?.identifier).toBe('b');
    });

    it('still wraps under queue loop', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.loopMode = 'queue';
      queue.advance();
      queue.advance();

      expect(queue.skip()?.identifier).toBe('a');
    });
  });

  describe('mutations', () => {
    it('removes an upcoming track by relative index', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b', 'c'));
      queue.advance(); // playing a

      const removed = queue.removeUpcoming(1); // 'c'
      expect(removed?.identifier).toBe('c');
      expect(queue.upcoming.map((t) => t.identifier)).toEqual(['b']);
    });

    it('refuses to remove the current track or out-of-range positions', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b'));
      queue.advance();

      expect(queue.removeUpcoming(-1)).toBeNull();
      expect(queue.removeUpcoming(5)).toBeNull();
      expect(queue.current?.identifier).toBe('a');
    });

    it('clearUpcoming keeps history and the current track', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b', 'c', 'd'));
      queue.advance();
      queue.advance(); // playing b

      expect(queue.clearUpcoming()).toBe(2);
      expect(queue.current?.identifier).toBe('b');
      expect(queue.tracks.map((t) => t.identifier)).toEqual(['a', 'b']);
    });

    it('shuffle only reorders upcoming tracks', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b', 'c', 'd', 'e'));
      queue.advance(); // playing a

      // Deterministic "random": always 0 → rotates the tail predictably.
      queue.shuffle(() => 0);

      expect(queue.current?.identifier).toBe('a');
      expect(new Set(queue.upcoming.map((t) => t.identifier))).toEqual(
        new Set(['b', 'c', 'd', 'e']),
      );
    });

    it('jumpTo moves to an absolute index and rejects bad ones', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a', 'b', 'c'));

      expect(queue.jumpTo(2)?.identifier).toBe('c');
      expect(queue.jumpTo(99)).toBeNull();
      expect(queue.current?.identifier).toBe('c');
    });

    it('reset drops everything including loop mode', () => {
      const queue = new TrackQueue();
      queue.add(tracks('a'));
      queue.loopMode = 'queue';
      queue.reset();

      expect(queue.isEmpty).toBe(true);
      expect(queue.loopMode).toBe('off');
      expect(queue.current).toBeNull();
    });
  });

  describe('previous / move / swap', () => {
    it('previous steps back through history and stops at the start', () => {
      const queue = new TrackQueue();
      queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
      queue.advance(); // a
      queue.advance(); // b
      queue.advance(); // c

      expect(queue.previous()?.identifier).toBe('b');
      expect(queue.previous()?.identifier).toBe('a');
      expect(queue.previous()).toBeNull();
      expect(queue.current?.identifier).toBe('a');
    });

    it('previous returns null before anything has played', () => {
      const queue = new TrackQueue();
      queue.add([makeTrack('a')]);
      expect(queue.previous()).toBeNull();
    });

    it('moveUpcoming reorders only upcoming tracks', () => {
      const queue = new TrackQueue();
      queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d')]);
      queue.advance(); // playing a; upcoming b,c,d

      const moved = queue.moveUpcoming(2, 0); // d to the front
      expect(moved?.identifier).toBe('d');
      expect(queue.upcoming.map((track) => track.identifier)).toEqual(['d', 'b', 'c']);
      expect(queue.current?.identifier).toBe('a');
    });

    it('moveUpcoming rejects out-of-range positions', () => {
      const queue = new TrackQueue();
      queue.add([makeTrack('a'), makeTrack('b')]);
      queue.advance(); // upcoming: b

      expect(queue.moveUpcoming(0, 5)).toBeNull();
      expect(queue.moveUpcoming(-1, 0)).toBeNull();
      expect(queue.moveUpcoming(0, 0)?.identifier).toBe('b');
    });

    it('swapUpcoming exchanges two upcoming tracks', () => {
      const queue = new TrackQueue();
      queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d')]);
      queue.advance(); // upcoming b,c,d

      expect(queue.swapUpcoming(0, 2)).toBe(true);
      expect(queue.upcoming.map((track) => track.identifier)).toEqual(['d', 'c', 'b']);
      expect(queue.swapUpcoming(0, 9)).toBe(false);
    });
  });

  describe('restore', () => {
    it('rehydrates tracks, cursor and loop mode', () => {
      const queue = new TrackQueue();
      queue.restore(tracks('a', 'b', 'c'), 1, 'queue');

      expect(queue.current?.identifier).toBe('b');
      expect(queue.loopMode).toBe('queue');
      expect(queue.upcoming.map((t) => t.identifier)).toEqual(['c']);
    });

    it('clamps an out-of-range cursor', () => {
      const queue = new TrackQueue();
      queue.restore(tracks('a'), 99, 'off');
      expect(queue.current).toBeNull();
    });
  });

  it('upcomingDurationMs ignores live streams', () => {
    const queue = new TrackQueue();
    queue.add([
      makeTrack('a'),
      makeTrack('live', { isStream: true, durationMs: 999_999_999 }),
      makeTrack('b'),
    ]);
    queue.advance(); // playing a

    expect(queue.upcomingDurationMs).toBe(180_000);
  });
});

describe('track helpers', () => {
  it('buildSearchQuery passes URLs through and prefixes searches', () => {
    expect(buildSearchQuery('https://youtu.be/x', 'youtube')).toBe('https://youtu.be/x');
    expect(buildSearchQuery('never gonna', 'youtube')).toBe('ytsearch:never gonna');
    expect(buildSearchQuery('never gonna', 'soundcloud')).toBe('scsearch:never gonna');
  });

  it('mapSource maps known sources and defaults to youtube', () => {
    expect(mapSource('Spotify')).toBe('spotify');
    expect(mapSource('deezer')).toBe('deezer');
    expect(mapSource('bandcamp')).toBe('youtube');
  });

  it('formatTrackDuration renders m:ss, h:mm:ss and live', () => {
    expect(formatTrackDuration({ durationMs: 65_000, isStream: false })).toBe('1:05');
    expect(formatTrackDuration({ durationMs: 3_725_000, isStream: false })).toBe('1:02:05');
    expect(formatTrackDuration({ durationMs: 0, isStream: true })).toBe('🔴 LIVE');
  });

  it('trackLink escapes brackets and tolerates missing URIs', () => {
    expect(trackLink(makeTrack('a', { title: '[Official] Song' }))).toBe(
      '[(Official) Song](https://example.com/a)',
    );
    expect(trackLink(makeTrack('a', { uri: null }))).toBe('Track a');
  });
});

import { describe, expect, it } from 'vitest';

import { queuedKeys, withoutQueued } from './queue-dedupe.js';
import type { QueuedTrack } from './track.js';

function queued(overrides: Partial<QueuedTrack>): QueuedTrack {
  return {
    encoded: 'x',
    identifier: 'id',
    title: 'Title',
    author: 'Artist',
    durationMs: 1000,
    uri: null,
    artworkUrl: null,
    isStream: false,
    source: 'spotify',
    requestedById: '1',
    requestedByName: 'someone',
    ...overrides,
  };
}

const candidate = (title: string, artist: string, uri: string | null = null) => ({
  title,
  artist,
  uri,
});

describe('withoutQueued', () => {
  it('keeps everything when the queue is empty', () => {
    const { keep, skipped } = withoutQueued(
      [candidate('Loser', 'Tame Impala'), candidate('Elephant', 'Tame Impala')],
      queuedKeys([]),
    );
    expect(keep).toHaveLength(2);
    expect(skipped).toBe(0);
  });

  it('drops a track already queued under the same Spotify id', () => {
    const existing = queuedKeys([
      queued({ uri: 'https://open.spotify.com/track/3RmFPuTTAjSQ2pbEd2j9oA' }),
    ]);
    const { keep, skipped } = withoutQueued(
      [
        // Same id, the `spotify:track:` spelling, and a different title —
        // the id alone has to be enough.
        candidate('Anything At All', 'Whoever', 'spotify:track:3RmFPuTTAjSQ2pbEd2j9oA'),
        candidate('Elephant', 'Tame Impala', 'spotify:track:0000000000000000000000'),
      ],
      existing,
    );
    expect(keep.map((track) => track.title)).toEqual(['Elephant']);
    expect(skipped).toBe(1);
  });

  it('drops the same song queued earlier from another provider', () => {
    // The point of the canonical key: a YouTube upload carries decorated
    // titles and no Spotify id, so only artist+title can connect the two.
    const existing = queuedKeys([
      queued({
        title: 'Tame Impala - Loser (Official Video)',
        author: 'tameimpalaVEVO',
        uri: 'https://www.youtube.com/watch?v=s3a4OQR-10M',
        source: 'youtube',
      }),
      queued({ title: 'Elephant', author: 'Tame Impala', uri: null, source: 'youtube' }),
    ]);
    const { keep, skipped } = withoutQueued(
      [candidate('Elephant', 'Tame Impala'), candidate('Borderline', 'Tame Impala')],
      existing,
    );
    expect(keep.map((track) => track.title)).toEqual(['Borderline']);
    expect(skipped).toBe(1);
  });

  it('collapses a track the playlist lists twice', () => {
    const { keep, skipped } = withoutQueued(
      [
        candidate('Loser', 'Tame Impala', 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA'),
        candidate('Loser', 'Tame Impala', 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA'),
        candidate('Elephant', 'Tame Impala'),
      ],
      queuedKeys([]),
    );
    expect(keep).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('counts a fully-duplicate playlist as entirely skipped', () => {
    const existing = queuedKeys([
      queued({ title: 'Loser', author: 'Tame Impala' }),
      queued({ title: 'Elephant', author: 'Tame Impala' }),
    ]);
    const { keep, skipped } = withoutQueued(
      [candidate('Loser', 'Tame Impala'), candidate('Elephant', 'Tame Impala')],
      existing,
    );
    expect(keep).toEqual([]);
    expect(skipped).toBe(2);
  });

  it('preserves playlist order among the survivors', () => {
    const existing = queuedKeys([queued({ title: 'Two', author: 'A' })]);
    const { keep } = withoutQueued(
      [candidate('One', 'A'), candidate('Two', 'A'), candidate('Three', 'A')],
      existing,
    );
    expect(keep.map((track) => track.title)).toEqual(['One', 'Three']);
  });

  it('matches an already-played track, not just the upcoming ones', () => {
    // `queuedKeys` is handed the whole queue on purpose: a song that played
    // two tracks ago is still in this queue as far as the listener is
    // concerned, and re-adding it is the same duplicate by another route.
    const existing = queuedKeys([
      queued({ title: 'Played Already', author: 'A' }),
      queued({ title: 'Playing Now', author: 'B' }),
    ]);
    const { keep, skipped } = withoutQueued([candidate('Played Already', 'A')], existing);
    expect(keep).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('treats a non-Spotify uri as carrying no id', () => {
    const existing = queuedKeys([
      queued({ title: 'Something', author: 'A', uri: 'https://example.com/track/abc' }),
    ]);
    // Different song, unrelated uri — must not collide on the uri path.
    const { keep } = withoutQueued(
      [candidate('Different', 'B', 'https://example.com/x')],
      existing,
    );
    expect(keep).toHaveLength(1);
  });
});

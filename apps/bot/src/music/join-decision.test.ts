/**
 * `/join` picks up a channel's saved queue.
 *
 * The case worth pinning is the middle one: restoring a queue has always
 * happened on join, but it only ever filled the queue — playback was a side
 * effect of `/play` enqueuing the track it was handed. A channel with a saved
 * queue could therefore be rejoined and would sit there silent.
 */
import { describe, expect, it } from 'vitest';

import { decideJoin } from './join-decision.js';

describe('decideJoin', () => {
  /** Someone is listening; rejoining would take their session over. */
  it('leaves a live session alone', () => {
    expect(decideJoin({ isPlaying: true, hasCurrentTrack: true, currentIndex: 3 })).toEqual({
      kind: 'already-playing',
    });
  });

  /** Checked before anything else — a live session outranks the request. */
  it('leaves a live session alone even with an empty cursor', () => {
    expect(decideJoin({ isPlaying: true, hasCurrentTrack: false, currentIndex: 0 })).toEqual({
      kind: 'already-playing',
    });
  });

  /** The reason this command exists. */
  it('resumes from the restored cursor', () => {
    expect(decideJoin({ isPlaying: false, hasCurrentTrack: true, currentIndex: 4 })).toEqual({
      kind: 'resume',
      fromIndex: 4,
    });
  });

  it('resumes from the start of a queue that never advanced', () => {
    expect(decideJoin({ isPlaying: false, hasCurrentTrack: true, currentIndex: 0 })).toEqual({
      kind: 'resume',
      fromIndex: 0,
    });
  });

  /**
   * Joining an empty room is a reasonable thing to ask for — a channel with
   * nothing saved, or a queue older than the resume window, is not an error.
   */
  it('joins an empty channel without treating it as a failure', () => {
    expect(decideJoin({ isPlaying: false, hasCurrentTrack: false, currentIndex: 0 })).toEqual({
      kind: 'empty',
    });
  });
});

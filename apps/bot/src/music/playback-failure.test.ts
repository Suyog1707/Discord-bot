import { describe, expect, it } from 'vitest';

import { isTruncatedPlayback } from './guild-player.js';

/**
 * The rule that separates "the song ended" from "the source stopped sending".
 *
 * Lavalink cannot tell these apart: a stream that hits end-of-file early and a
 * song that reaches its last frame both surface as `finished`. Every case here
 * is one that actually happened or plausibly will.
 */
describe('isTruncatedPlayback', () => {
  const song = { reason: 'finished', expectedMs: 258_000 };

  it('flags a 30-second SoundCloud preview of a four-minute track', () => {
    // The exact production failure: metadata advertises 258s, the /preview/
    // stream delivers 30, and Lavalink calls it a completion.
    expect(isTruncatedPlayback({ ...song, reachedMs: 30_000 })).toBe(true);
  });

  it('flags a stream that dies after four seconds', () => {
    expect(isTruncatedPlayback({ reason: 'finished', expectedMs: 163_000, reachedMs: 4_100 })).toBe(
      true,
    );
  });

  it('accepts a track that played to the end', () => {
    expect(isTruncatedPlayback({ ...song, reachedMs: 258_000 })).toBe(false);
    expect(isTruncatedPlayback({ ...song, reachedMs: 257_500 })).toBe(false);
  });

  it('tolerates ordinary end-of-file imprecision', () => {
    // A trailing silent frame or a container rounding its duration up must not
    // be read as a failure.
    expect(isTruncatedPlayback({ ...song, reachedMs: 255_000 })).toBe(false);
  });

  it('needs both bounds exceeded, never one alone', () => {
    // Short in absolute terms but a tiny fraction of a long track.
    expect(
      isTruncatedPlayback({ reason: 'finished', expectedMs: 3_600_000, reachedMs: 3_580_000 }),
    ).toBe(false);
    // A large fraction of a very short track, but only seconds missing.
    expect(isTruncatedPlayback({ reason: 'finished', expectedMs: 20_000, reachedMs: 8_000 })).toBe(
      false,
    );
  });

  it('never fires on a reason that already explains itself', () => {
    // A skip, a stop, a jump and a load failure are all accounted for
    // elsewhere; only a claimed completion can be a false completion.
    for (const reason of ['stopped', 'replaced', 'loadFailed', 'cleanup']) {
      expect(isTruncatedPlayback({ reason, expectedMs: 258_000, reachedMs: 4_000 })).toBe(false);
    }
  });

  it('ignores livestreams, which have no runtime to fall short of', () => {
    expect(
      isTruncatedPlayback({ reason: 'finished', expectedMs: 0, reachedMs: 4_000, isStream: true }),
    ).toBe(false);
    expect(
      isTruncatedPlayback({
        reason: 'finished',
        expectedMs: 258_000,
        reachedMs: 4_000,
        isStream: true,
      }),
    ).toBe(false);
  });

  it('ignores a track of unknown length', () => {
    expect(isTruncatedPlayback({ reason: 'finished', expectedMs: 0, reachedMs: 4_000 })).toBe(false);
  });
});

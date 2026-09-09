/* eslint-disable @typescript-eslint/unbound-method -- these are spies being
   asserted on, never detached and called. */
/**
 * One intent, applied to the room that owns it.
 *
 * This is the single place a serialised request becomes a call on a live
 * player, and it is what lets a command reach a room in another container
 * without any of the things that cannot cross a wire — the live queue, the
 * closure-taking methods, the object-identity comparisons — ever leaving the
 * process they work in.
 */
import { describe, expect, it, vi } from 'vitest';

import { applyIntent } from './apply-intent.js';
import { roomIntentSchema } from './intent.js';
import type { RoomPlayer } from './player-router.js';

const GUILD = '111111111111111111';
const VOICE = '222222222222222222';
const USER = '333333333333333333';

function track(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    author: 'Artist',
    identifier: `id-${title}`,
    uri: null,
    sourceKey: undefined,
    durationMs: 180_000,
    isStream: false,
    ...overrides,
  };
}

function fakeRoom(overrides: Record<string, unknown> = {}): RoomPlayer & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const record =
    (name: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls[name] = args;
      return result;
    };

  const player = {
    voiceChannelId: VOICE,
    paused: false,
    queue: { current: track('Playing'), currentIndex: 2, upcoming: [track('A'), track('B')] },
    pause: vi.fn(() => {
      player.paused = true;
    }),
    resume: vi.fn(() => {
      player.paused = false;
    }),
    skip: vi.fn(() => Promise.resolve(track('Skipped'))),
    stop: vi.fn(record('stop')),
    previous: vi.fn(() => Promise.resolve(track('Previous'))),
    restart: vi.fn(() => Promise.resolve(track('Restarted'))),
    shuffle: vi.fn(record('shuffle')),
    setVolume: vi.fn(record('setVolume')),
    seekTo: vi.fn(record('seekTo')),
    setLoopMode: vi.fn(record('setLoopMode')),
    jumpTo: vi.fn(() => Promise.resolve(track('Jumped'))),
    removeUpcoming: vi.fn(() => track('Removed')),
    moveUpcoming: vi.fn(() => track('Moved')),
    swapUpcoming: vi.fn(() => true),
    clearUpcoming: vi.fn(() => 7),
    setListener: vi.fn(record('setListener')),
    setStayConnected: vi.fn(record('setStayConnected')),
    setAutoplayEnabled: vi.fn(record('setAutoplayEnabled')),
    snapshot: vi.fn(() => ({ paused: false })),
    isPlaying: false,
    enqueue: vi.fn(() => Promise.resolve({ position: 3, startedPlayback: true })),
    ...overrides,
  };

  const music = {
    isSessionListener: vi.fn(() => true),
    applyDislike: vi.fn(() => ({ evicted: 0 })),
    forgetDislike: vi.fn(),
    sessionDj: {
      host: vi.fn(() => USER),
      djIds: vi.fn(() => ['444444444444444444']),
      setHost: vi.fn(),
    },
    takeResumeNotice: vi.fn(() => null),
  };

  return { botId: 'main', voiceChannelId: VOICE, player, music, calls } as never;
}

const base = { guildId: GUILD, voiceChannelId: VOICE, issuedBy: USER } as const;

/** What `decodeIntent` used to do, now that only the schema remains. */
function decode(raw: unknown) {
  const result = roomIntentSchema.safeParse(raw);
  return result.success ? result.data : null;
}

describe('intent schema', () => {
  it('accepts a well-formed intent', () => {
    expect(decode({ action: 'skip', ...base })).toEqual({ action: 'skip', ...base });
  });

  it('rejects an unknown action', () => {
    expect(decode({ action: 'self-destruct', ...base })).toBeNull();
  });

  /** Every intent names its room; without that one room could reach another. */
  it('rejects an intent with no room', () => {
    expect(decode({ action: 'skip', guildId: GUILD, issuedBy: USER })).toBeNull();
  });

  it('rejects an out-of-range queue position', () => {
    expect(decode({ action: 'remove', ...base, position: 0 })).toBeNull();
  });

  it('defaults a dislike to skipping what is playing', () => {
    const intent = decode({ action: 'dislike', ...base, trackKey: 'artist::song' });
    expect(intent).toMatchObject({ skipIfPlaying: true });
  });

  it('covers every action in the union', () => {
    // A guard against adding a schema variant and forgetting to handle it.
    const actions = roomIntentSchema.options.map((option) => option.shape.action.value);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain('authority');
    expect(actions).toContain('snapshot');
  });
});

describe('applyIntent', () => {
  it('pauses and resumes', async () => {
    const room = fakeRoom();

    expect(await applyIntent(room, { action: 'pause', ...base })).toEqual({ kind: 'ok' });
    expect(await applyIntent(room, { action: 'resume', ...base })).toEqual({ kind: 'ok' });
  });

  /**
   * The state check lives here rather than in the command: whether playback is
   * already paused is a fact about the room, and asking for it separately
   * would cost a second round trip to learn what the owner already knows.
   */
  it('refuses to pause what is already paused', async () => {
    const room = fakeRoom();
    await applyIntent(room, { action: 'pause', ...base });

    expect(await applyIntent(room, { action: 'pause', ...base })).toMatchObject({
      kind: 'error',
    });
  });

  it('refuses to resume what is not paused', async () => {
    expect(await applyIntent(fakeRoom(), { action: 'resume', ...base })).toMatchObject({
      kind: 'error',
    });
  });

  it('reports the end of the queue rather than a silent no-op', async () => {
    const room = fakeRoom({ previous: vi.fn(() => Promise.resolve(null)) });

    expect(await applyIntent(room, { action: 'previous', ...base })).toMatchObject({
      kind: 'error',
    });
  });

  it('refuses to seek a live stream', async () => {
    const room = fakeRoom({
      queue: { current: track('Live', { isStream: true }), currentIndex: 0, upcoming: [] },
    });

    expect(await applyIntent(room, { action: 'seek', ...base, positionMs: 1_000 })).toMatchObject({
      kind: 'error',
    });
  });

  it('refuses to seek past the end of a track', async () => {
    const room = fakeRoom({
      queue: {
        current: track('Short', { durationMs: 1_000, isStream: false }),
        currentIndex: 0,
        upcoming: [],
      },
    });

    expect(await applyIntent(room, { action: 'seek', ...base, positionMs: 999_000 })).toMatchObject(
      { kind: 'error' },
    );
  });

  it('returns the track a skip removed, summarised rather than whole', async () => {
    const result = await applyIntent(fakeRoom(), { action: 'skip', ...base });

    expect(result).toEqual({
      kind: 'track',
      track: { title: 'Skipped', author: 'Artist', identifier: 'id-Skipped', uri: null },
    });
  });

  /** Positions are 1-based against the upcoming list, as every queue view shows. */
  it('jumps relative to the current cursor', async () => {
    const room = fakeRoom();

    await applyIntent(room, { action: 'jump', ...base, position: 3 });

    expect(room.player.jumpTo).toHaveBeenCalledWith(5);
  });

  it('converts a 1-based removal to a 0-based index', async () => {
    const room = fakeRoom();

    await applyIntent(room, { action: 'remove', ...base, position: 1 });

    expect(room.player.removeUpcoming).toHaveBeenCalledWith(0);
  });

  it('reports how many tracks a clear removed', async () => {
    expect(await applyIntent(fakeRoom(), { action: 'clear', ...base })).toEqual({
      kind: 'count',
      count: 7,
    });
  });

  it('reports a swap that could not be made as an error, not a success', async () => {
    const room = fakeRoom({ swapUpcoming: vi.fn(() => false) });

    expect(await applyIntent(room, { action: 'swap', ...base, a: 1, b: 9 })).toMatchObject({
      kind: 'error',
    });
  });

  describe('dislike', () => {
    /**
     * The comparison is by KEY, not by object identity. The caller may be in
     * another process and cannot hand over the same object.
     */
    it('recognises the playing track by its canonical key', async () => {
      const room = fakeRoom({
        queue: {
          current: track('Kesariya', { author: 'Arijit Singh' }),
          currentIndex: 0,
          upcoming: [],
        },
      });

      const result = await applyIntent(room, {
        action: 'dislike',
        ...base,
        trackKey: 'arijit singh::kesariya',
        skipIfPlaying: true,
      });

      expect(result).toMatchObject({ kind: 'track' });
      expect(room.player.skip).toHaveBeenCalled();
    });

    it('recognises it by the key it was picked as', async () => {
      const room = fakeRoom({
        queue: {
          current: track('Some Upload', { sourceKey: 'artist::song' }),
          currentIndex: 0,
          upcoming: [],
        },
      });

      await applyIntent(room, {
        action: 'dislike',
        ...base,
        trackKey: 'artist::song',
        skipIfPlaying: true,
      });

      expect(room.player.skip).toHaveBeenCalled();
    });

    it('stores but does not skip for someone outside the session', async () => {
      const room = fakeRoom();
      room.music.isSessionListener = vi.fn(() => false);

      await applyIntent(room, {
        action: 'dislike',
        ...base,
        trackKey: 'artist::song',
        skipIfPlaying: true,
      });

      expect(room.player.skip).not.toHaveBeenCalled();
      expect(room.music.applyDislike).not.toHaveBeenCalled();
    });

    it('does not skip a song that is not the one playing', async () => {
      const room = fakeRoom();

      await applyIntent(room, {
        action: 'dislike',
        ...base,
        trackKey: 'somebody::else',
        skipIfPlaying: true,
      });

      expect(room.player.skip).not.toHaveBeenCalled();
      expect(room.music.applyDislike).toHaveBeenCalled();
    });
  });

  /** Exactly the three values the DJ guard needs, all scalars. */
  it('answers the authority read with the room DJ state', async () => {
    expect(await applyIntent(fakeRoom(), { action: 'authority', ...base })).toEqual({
      kind: 'authority',
      botVoiceChannelId: VOICE,
      hostId: USER,
      sessionDjIds: ['444444444444444444'],
    });
  });

  it('answers a snapshot read', async () => {
    expect(await applyIntent(fakeRoom(), { action: 'snapshot', ...base })).toMatchObject({
      kind: 'snapshot',
    });
  });
});

describe('enqueue', () => {
  it('returns everything the reply needs, so nothing has to be read back', () => {
    // The point of the intent: one round trip. Asking for the position and the
    // resume notice separately would be two more, racing the music itself.
    const room = fakeRoom();
    return expect(
      applyIntent(room, {
        action: 'enqueue',
        ...base,
        tracks: [track('New')] as never,
        next: false,
      }),
    ).resolves.toEqual({
      kind: 'enqueued',
      startedPlayback: true,
      upcomingCount: 2,
      resumed: null,
    });
  });

  it('passes the "up next" flag through', async () => {
    const room = fakeRoom();
    await applyIntent(room, {
      action: 'enqueue',
      ...base,
      tracks: [track('New')] as never,
      next: true,
    });

    expect(room.player.enqueue).toHaveBeenCalledWith([track('New')], { next: true });
  });
});

describe('join-session', () => {
  it('resumes from the saved cursor', async () => {
    const room = fakeRoom();
    const result = await applyIntent(room, { action: 'join-session', ...base });

    // The queue has always come back on join; starting it is what `/join` adds.
    expect(room.player.jumpTo).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ kind: 'joined', outcome: 'resumed' });
  });

  it('makes the caller the host, whoever the queue remembered', async () => {
    const room = fakeRoom();
    await applyIntent(room, { action: 'join-session', ...base });

    expect(room.player.setListener).toHaveBeenCalledWith(USER);
    expect(room.music.sessionDj.setHost).toHaveBeenCalledWith(GUILD, USER);
  });

  it('leaves a live session alone', async () => {
    // Somebody is already listening here. Taking the host seat and pointing
    // autoplay at whoever typed the command would hijack their session.
    const room = fakeRoom({ isPlaying: true });
    const result = await applyIntent(room, { action: 'join-session', ...base });

    expect(result).toMatchObject({ kind: 'joined', outcome: 'already-playing' });
    expect(room.player.setListener).not.toHaveBeenCalled();
    expect(room.player.jumpTo).not.toHaveBeenCalled();
  });

  it('joining an empty channel is not an error', async () => {
    const room = fakeRoom({ queue: { current: null, currentIndex: 0, upcoming: [] } });
    const result = await applyIntent(room, { action: 'join-session', ...base });

    expect(result).toMatchObject({ kind: 'joined', outcome: 'empty' });
    expect(room.player.jumpTo).not.toHaveBeenCalled();
  });
});

/**
 * GuildPlayer: the autoplay refill machinery, and the playback controls it
 * must not disturb.
 *
 * Everything here runs against a fake Shoukaku `Player` and a fake
 * `QueueStore`, because the behaviour under test is entirely about WHEN the
 * player asks for more music and WHICH track it hands to Lavalink next — never
 * about the wire protocol. The two paths that matter are deliberately kept
 * apart: the low-water refill runs from the 'start' event while music is
 * playing, and the drain path runs from 'end' once the queue has actually run
 * out. Tests for the drain path therefore never emit 'start', or the refill
 * would top the queue up and the drain would never happen.
 */
import type { Client } from 'discord.js';
import type { Player } from 'shoukaku';
import { describe, expect, it, vi } from 'vitest';

import { GuildPlayer } from './guild-player.js';
import type { QueueStore } from './queue-store.js';
import type { QueuedTrack, TrackOrigin } from './track.js';

/** Every fixture track claims the same runtime, so shortfalls are comparable. */
const TRACK_MS = 180_000;

/* ------------------------------------------------------------------ fixtures */

function track(id: string, title: string, origin: TrackOrigin = 'user'): QueuedTrack {
  const autoplay = origin === 'autoplay';
  return {
    encoded: `encoded-${id}`,
    identifier: id,
    title,
    author: 'Artist',
    durationMs: TRACK_MS,
    uri: `https://example.com/${id}`,
    artworkUrl: null,
    isStream: false,
    source: 'youtube',
    requestedById: autoplay ? '0' : '123456789012345678',
    requestedByName: autoplay ? 'Autoplay' : 'Tester',
    origin,
  };
}

/** An autoplay-originated pick — `TrackQueue.add` treats these as radio. */
function pick(id: string): QueuedTrack {
  return track(id, `Pick ${id}`, 'autoplay');
}

/** `count` distinct picks, as a generator would return them. */
function picks(count: number, prefix = 'auto'): readonly QueuedTrack[] {
  return Array.from({ length: count }, (_unused, index) => pick(`${prefix}-${String(index)}`));
}

/* --------------------------------------------------------------- fake player */

type Handler = (payload: never) => void;

interface PlayPayload {
  readonly track: { readonly encoded: string; readonly userData?: { readonly playSeq: number } };
  readonly volume: number;
}

interface FakePlayer {
  position: number;
  paused: boolean;
  readonly node: { readonly name: string };
  track: string | null;
  readonly on: (event: string, handler: Handler) => FakePlayer;
  readonly once: (event: string, handler: Handler) => FakePlayer;
  readonly removeAllListeners: () => FakePlayer;
  readonly emit: (event: string, payload?: unknown) => void;
  readonly playTrack: ReturnType<typeof vi.fn<(options: PlayPayload) => Promise<void>>>;
  readonly stopTrack: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly seekTo: ReturnType<typeof vi.fn<(positionMs: number) => Promise<void>>>;
  readonly setPaused: ReturnType<typeof vi.fn<(state: boolean) => Promise<void>>>;
  readonly setGlobalVolume: ReturnType<typeof vi.fn<(volume: number) => Promise<void>>>;
  readonly clearFilters: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly setFilters: ReturnType<typeof vi.fn<(filters: unknown) => Promise<void>>>;
}

function fakePlayer(): FakePlayer {
  const listeners = new Map<string, Handler[]>();
  const once = new Set<Handler>();

  const emit = (event: string, payload?: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      if (once.has(handler)) {
        once.delete(handler);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((other) => other !== handler),
        );
      }
      (handler as (value: unknown) => void)(payload);
    }
  };

  const add = (event: string, handler: Handler): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
  };

  const player: FakePlayer = {
    position: 0,
    paused: false,
    node: { name: 'test' },
    track: null,
    on: (event, handler) => {
      add(event, handler);
      return player;
    },
    once: (event, handler) => {
      once.add(handler);
      add(event, handler);
      return player;
    },
    removeAllListeners: () => {
      listeners.clear();
      once.clear();
      return player;
    },
    emit,
    playTrack: vi.fn((_options: PlayPayload) => Promise.resolve()),
    // Lavalink answers a stop with an end event; it never arrives in the same
    // tick, which is exactly why `skip()` cannot see the advance it caused.
    stopTrack: vi.fn(() => {
      // Captured now, not when the microtask runs: the end names the track
      // that was stopped, exactly as Lavalink reports it.
      const stopped = lastPlayed(player);
      queueMicrotask(() => {
        emit('end', { reason: 'stopped', track: stopped });
      });
      return Promise.resolve();
    }),
    seekTo: vi.fn((_positionMs: number) => Promise.resolve()),
    setPaused: vi.fn((state: boolean) => {
      player.paused = state;
      return Promise.resolve();
    }),
    setGlobalVolume: vi.fn((_volume: number) => Promise.resolve()),
    clearFilters: vi.fn(() => Promise.resolve()),
    setFilters: vi.fn((_filters: unknown) => Promise.resolve()),
  };

  return player;
}

/** The encoded blobs handed to Lavalink, in order. */
function played(player: FakePlayer): readonly string[] {
  return player.playTrack.mock.calls.map(([options]) => options.track.encoded);
}

/* -------------------------------------------------------------------- harness */

type AutoplayRequest = (guildId: string, count: number) => Promise<readonly QueuedTrack[]>;

const noPicks: AutoplayRequest = () => Promise.resolve([]);

interface HarnessOptions {
  readonly autoplayEnabled?: boolean;
  readonly lowWaterMark?: number;
  readonly targetQueueSize?: number;
  readonly autoplay?: AutoplayRequest;
  readonly announce?: boolean;
}

interface Harness {
  readonly gp: GuildPlayer;
  readonly player: FakePlayer;
  readonly autoplay: ReturnType<typeof vi.fn<AutoplayRequest>>;
  readonly fetchChannel: ReturnType<typeof vi.fn<(id: string) => Promise<null>>>;
  readonly store: {
    readonly scheduleSave: ReturnType<typeof vi.fn>;
    readonly flush: ReturnType<typeof vi.fn>;
    readonly recordHistory: ReturnType<typeof vi.fn>;
  };
  readonly selfDestruct: ReturnType<typeof vi.fn>;
}

function harness(options: HarnessOptions = {}): Harness {
  const player = fakePlayer();
  const fetchChannel = vi.fn((_id: string) => Promise.resolve(null));
  const client = {
    channels: { fetch: fetchChannel },
    user: { id: 'bot' },
  } as unknown as Client;
  const store = {
    scheduleSave: vi.fn(),
    flush: vi.fn(() => Promise.resolve(undefined)),
    recordHistory: vi.fn(() => Promise.resolve(undefined)),
  };
  const autoplay = vi.fn<AutoplayRequest>(options.autoplay ?? noPicks);
  const selfDestruct = vi.fn(() => Promise.resolve(undefined));

  const gp = new GuildPlayer({
    guildId: 'guild-1',
    voiceChannelId: 'voice-1',
    textChannelId: 'text-1',
    player: player as unknown as Player,
    client,
    store: store as unknown as QueueStore,
    // Announcements poll for cross-platform links on a real timer; the queue
    // behaviour under test is unaffected by them, so they stay off.
    announce: options.announce ?? false,
    initialVolume: 100,
    // Long enough that the idle timer never fires inside a test.
    idleTimeoutSeconds: 300,
    stayConnected: false,
    autoplayEnabled: options.autoplayEnabled ?? false,
    autoplayLowWaterMark: options.lowWaterMark ?? 2,
    autoplayTargetQueueSize: options.targetQueueSize ?? 4,
    onSelfDestruct: selfDestruct,
    onAutoplayRequest: autoplay,
  });

  return { gp, player, autoplay, fetchChannel, store, selfDestruct };
}

/**
 * Let the fire-and-forget handlers finish. The refill loop chains several
 * awaits per iteration, so this has to be generous rather than exact.
 */
async function settle(turns = 40): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A track that played all the way through. `position` matters: a "finished"
 * end far short of the runtime is read as a truncated stream, which is a
 * different code path entirely.
 */
function endNaturally(player: FakePlayer, ended = lastPlayed(player)): void {
  player.position = TRACK_MS;
  // Lavalink names the track that ended in every end event; the guard
  // against duplicated ends relies on it, so the fake does the same.
  player.emit('end', { reason: 'finished', track: ended });
}

/**
 * The track the fake node reports in an event, shaped the way a real Lavalink
 * node shapes it.
 *
 * The `encoded` blob is deliberately NOT the blob that was handed to
 * `playTrack`. Lavalink re-encodes the live track for every event it sends,
 * and the playback position is part of that encoding, so the string that comes
 * back when a song ends is never the string that was sent when it started.
 * Modelling that faithfully is the whole point: a fake that echoed the blob
 * back let a guard comparing `encoded` pass every test while wedging the
 * player after one track in production.
 */
function lavalinkEventTrack(
  encoded: string,
  positionMs: number,
  userData?: { readonly playSeq: number },
): {
  readonly encoded: string;
  readonly info: { readonly identifier: string };
  readonly userData?: { readonly playSeq: number };
} {
  return {
    encoded: `${encoded}@${String(positionMs)}`,
    // Fixtures use `encoded-<id>` for a track whose identifier is `<id>`.
    info: { identifier: encoded.replace(/^encoded-/u, '') },
    // Lavalink echoes whatever `userData` the track was played with.
    ...(userData === undefined ? {} : { userData }),
  };
}

/** The track the fake node is "playing": whatever `playTrack` was last given. */
function lastPlayed(player: FakePlayer):
  | {
      readonly encoded: string;
      readonly info: { readonly identifier: string };
      readonly userData?: { readonly playSeq: number };
    }
  | undefined {
  const calls = player.playTrack.mock.calls;
  const last = calls[calls.length - 1]?.[0];
  return last === undefined
    ? undefined
    : lavalinkEventTrack(last.track.encoded, player.position, last.track.userData);
}

/* ---------------------------------------------------------------------- tests */

describe('GuildPlayer low-water autoplay refill', () => {
  it('tops the queue up to target when a track starts with nothing behind it', async () => {
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: (_guildId, count) => Promise.resolve(picks(count)),
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();

    // Upcoming was 0, so the request asks for a full target's worth.
    expect(h.autoplay).toHaveBeenCalledTimes(1);
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(h.gp.queue.upcoming).toHaveLength(4);
    expect(h.gp.autoplayThresholds).toEqual({ lowWaterMark: 2, targetQueueSize: 4 });
  });

  it('does not refill while the queue is above the low-water mark', async () => {
    const h = harness({ autoplayEnabled: true, lowWaterMark: 2, targetQueueSize: 4 });

    await h.gp.enqueue([1, 2, 3, 4, 5].map((n) => track(`t${String(n)}`, `Song ${String(n)}`)));
    h.player.emit('start');
    await settle();

    expect(h.gp.queue.upcoming).toHaveLength(4);
    expect(h.autoplay).not.toHaveBeenCalled();
  });

  it('runs one refill at a time, and none once the queue is full', async () => {
    let release: ((tracks: readonly QueuedTrack[]) => void) | undefined;
    const pending = new Promise<readonly QueuedTrack[]>((resolve) => {
      release = resolve;
    });
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: () => pending,
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    h.player.emit('start');
    await settle(3);

    // The second start landed while the first request was still in flight.
    expect(h.autoplay).toHaveBeenCalledTimes(1);

    release?.(picks(4));
    await settle();
    expect(h.gp.queue.upcoming).toHaveLength(4);

    h.player.emit('start');
    await settle();
    expect(h.autoplay).toHaveBeenCalledTimes(1);
  });

  it('keeps asking until the target is reached when each request underdelivers', async () => {
    let issued = 0;
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: () => {
        issued += 1;
        return Promise.resolve([pick(`drip-${String(issued)}`)]);
      },
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();

    // 0 → 1 → 2 → 3 → 4 upcoming: four requests, then the shortfall is zero.
    expect(h.autoplay).toHaveBeenCalledTimes(4);
    expect(h.gp.queue.upcoming).toHaveLength(4);
  });

  it('stops the moment a request comes back empty, instead of spinning', async () => {
    let issued = 0;
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: () => {
        issued += 1;
        return Promise.resolve(issued <= 2 ? [pick(`drip-${String(issued)}`)] : []);
      },
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();

    // Two productive requests plus the empty one that ends the loop — an
    // exhausted pool must cost one failed request, not a hot loop.
    expect(h.autoplay).toHaveBeenCalledTimes(3);
    expect(h.gp.queue.upcoming).toHaveLength(2);
  });

  it('never asks while autoplay is off, and refills the moment it is switched on', async () => {
    const h = harness({
      autoplayEnabled: false,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: (_guildId, count) => Promise.resolve(picks(count)),
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();
    expect(h.autoplay).not.toHaveBeenCalled();
    expect(h.gp.autoplayEnabled).toBe(false);

    h.gp.setAutoplayEnabled(true);
    await settle();

    expect(h.gp.autoplayEnabled).toBe(true);
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(h.gp.queue.upcoming).toHaveLength(4);
  });
});

describe('GuildPlayer drained-queue autoplay', () => {
  it('continues playing when the last track ends', async () => {
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: (_guildId, count) => Promise.resolve(picks(count)),
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    endNaturally(h.player);
    await settle();

    // The drain path asks for a full target, not a shortfall.
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(h.gp.queue.current?.identifier).toBe('auto-0');
    expect(h.gp.queue.upcoming).toHaveLength(3);
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-auto-0']);
    expect(h.store.recordHistory).toHaveBeenCalledTimes(1);
  });

  it('ends the queue only when autoplay has nothing left to give', async () => {
    const h = harness({ autoplayEnabled: true, autoplay: () => Promise.resolve([]) });

    await h.gp.enqueue([track('t1', 'Song One')]);
    endNaturally(h.player);
    await settle();

    expect(h.autoplay).toHaveBeenCalledTimes(1);
    // The "queue finished" notice is the only thing that goes out, and nothing
    // was handed to Lavalink a second time.
    expect(h.fetchChannel).toHaveBeenCalledWith('text-1');
    expect(played(h.player)).toEqual(['encoded-t1']);
    expect(h.gp.isPlaying).toBe(false);
  });

  it('retries once after a failed request and resumes playback', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const h = harness({
        autoplayEnabled: true,
        autoplay: () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new Error('recommender unavailable'))
            : Promise.resolve(picks(2, 'retry'));
        },
      });

      await h.gp.enqueue([track('t1', 'Song One')]);
      endNaturally(h.player);
      await vi.advanceTimersByTimeAsync(0);

      // The first attempt failed; nothing new is playing yet.
      expect(h.autoplay).toHaveBeenCalledTimes(1);
      expect(played(h.player)).toEqual(['encoded-t1']);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.autoplay).toHaveBeenCalledTimes(2);
      expect(played(h.player)).toEqual(['encoded-t1', 'encoded-retry-0']);
      expect(h.gp.queue.current?.identifier).toBe('retry-0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to autoplay when the last track will not play at all', async () => {
    const h = harness({
      autoplayEnabled: true,
      autoplay: (_guildId, count) => Promise.resolve(picks(count, 'rescue')),
    });
    h.player.playTrack.mockRejectedValueOnce(new Error('node refused the track'));

    await h.gp.enqueue([track('t1', 'Song One')]);
    await settle();

    // An unplayable last track is a drained queue, and autoplay gets its say
    // before the player parks.
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-rescue-0']);
    expect(h.gp.queue.current?.identifier).toBe('rescue-0');
  });
});

describe('GuildPlayer queue mutation', () => {
  it('removes every matching upcoming track and leaves the rest alone', async () => {
    const h = harness({ autoplayEnabled: false });

    await h.gp.enqueue([
      track('t1', 'Playing'),
      track('bad-1', 'Bad'),
      track('t2', 'Good'),
      track('bad-2', 'Bad'),
      track('t3', 'Other'),
    ]);
    h.player.emit('start');

    const removed = h.gp.removeUpcomingWhere((candidate) => candidate.title === 'Bad');

    // Returned in queue order, however the removal walked the list.
    expect(removed.map((entry) => entry.identifier)).toEqual(['bad-1', 'bad-2']);
    expect(h.gp.queue.upcoming.map((entry) => entry.identifier)).toEqual(['t2', 't3']);
    // The playing track is history, not a candidate for removal.
    expect(h.gp.queue.current?.identifier).toBe('t1');
    expect(h.gp.removeUpcomingWhere((candidate) => candidate.title === 'Bad')).toEqual([]);
  });

  it('advances exactly once when the same track end arrives twice', async () => {
    const h = harness({ autoplayEnabled: false });

    await h.gp.enqueue([track('t1', 'One'), track('t2', 'Two'), track('t3', 'Three')]);
    expect(h.gp.queue.currentIndex).toBe(0);

    // A duplicated end event: both describe t1, and the second arrives while
    // the track the first one started is already playing. It must not push
    // the queue on again.
    const ended = lastPlayed(h.player);
    endNaturally(h.player, ended);
    endNaturally(h.player, ended);
    await settle();

    expect(h.gp.queue.currentIndex).toBe(1);
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
  });
});

describe('GuildPlayer track-end correlation', () => {
  /**
   * The regression this suite exists for.
   *
   * Lavalink re-encodes the live track for every event it emits, and the
   * playback position is part of that encoding, so the `encoded` blob reported
   * when a song ends is never the blob that was handed over when it started.
   * A guard that compared the two called every natural end "an end for some
   * other track" and returned without advancing: the first song played, and
   * the session then sat silent with a full queue. `lavalinkEventTrack` models
   * that drift, so this asserts the property rather than the byte string.
   */
  it('starts the next queued track when the end reports a re-encoded blob', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    h.player.emit('start');
    await settle();

    const ended = lastPlayed(h.player);
    expect(ended?.encoded).not.toBe('encoded-t1');
    expect(ended?.info.identifier).toBe('t1');

    endNaturally(h.player);
    await settle();

    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
    expect(h.gp.queue.current?.identifier).toBe('t2');
  });

  it('advances the cursor exactly once for one natural end', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'Song One'), track('t2', 'Song Two'), track('t3', 'Three')]);
    h.player.emit('start');
    await settle();
    expect(h.gp.queue.currentIndex).toBe(0);

    endNaturally(h.player);
    await settle();

    expect(h.gp.queue.currentIndex).toBe(1);
    expect(played(h.player)).toHaveLength(2);
  });

  it('ignores an end naming a track the queue has already moved past', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'Song One'), track('t2', 'Song Two'), track('t3', 'Three')]);
    h.player.emit('start');
    await settle();

    endNaturally(h.player);
    await settle();
    expect(h.gp.queue.current?.identifier).toBe('t2');

    // A duplicate of the FIRST track's end, arriving late. It names t1, which
    // is no longer current, so it must not push the queue on to t3.
    h.player.position = TRACK_MS;
    h.player.emit('end', { reason: 'finished', track: lavalinkEventTrack('encoded-t1', TRACK_MS) });
    await settle();

    expect(h.gp.queue.current?.identifier).toBe('t2');
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
  });

  it('tells two plays of the same song apart', async () => {
    // The case an identifier cannot answer: the SAME track queued twice. A
    // duplicated end for the first play must not be read as the end of the
    // second, or the queue advances past a song that never played.
    const h = harness();
    await h.gp.enqueue([
      track('t1', 'Song One'),
      track('t1', 'Song One Again'),
      track('t2', 'Two'),
    ]);
    h.player.emit('start');
    await settle();

    const firstPlay = lastPlayed(h.player);
    expect(firstPlay?.userData?.playSeq).toBe(1);

    endNaturally(h.player);
    await settle();
    expect(played(h.player)).toHaveLength(2);

    // The first play's end, arriving again. Same identifier as what is now
    // playing; only the play token distinguishes them.
    h.player.emit('end', { reason: 'finished', track: firstPlay });
    await settle();

    expect(played(h.player)).toHaveLength(2);
    expect(h.gp.queue.current?.title).toBe('Song One Again');
  });

  it('ignores a repeat of the end for the play that is current', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'Song One'), track('t2', 'Song Two'), track('t3', 'Three')]);
    h.player.emit('start');
    await settle();

    const ended = lastPlayed(h.player);
    endNaturally(h.player, ended);
    await settle();
    endNaturally(h.player, ended);
    await settle();

    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
    expect(h.gp.queue.currentIndex).toBe(1);
  });

  it('does not let a duplicated end restart the music after a stop', async () => {
    // `stop()` empties the queue, so `current` is null and the identity guard
    // cannot help. Without the per-play guard the repeat would re-enter the
    // end handler with `#stopRequested` already spent and hand straight over
    // to autoplay — the music would come back after /stop.
    const h = harness({
      autoplayEnabled: true,
      autoplay: (_g, count) => Promise.resolve(picks(count)),
    });
    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();
    h.autoplay.mockClear();

    await h.gp.stop();
    await settle();
    const afterStop = played(h.player).length;

    h.player.emit('end', { reason: 'stopped', track: lastPlayed(h.player) });
    await settle();

    expect(played(h.player)).toHaveLength(afterStop);
    expect(h.autoplay).not.toHaveBeenCalled();
  });

  it('ignores an end for a play this process never started', async () => {
    // A resumed Lavalink session can replay its last event at a player that
    // has not been handed a track yet. Advancing on it would skip the first
    // track of the queue that is about to be restored.
    const h = harness();
    h.player.emit('end', {
      reason: 'finished',
      track: lavalinkEventTrack('encoded-ghost', TRACK_MS),
    });
    await settle();

    expect(played(h.player)).toHaveLength(0);
    expect(h.gp.queue.currentIndex).toBe(-1);
  });

  it('does not treat a load failure that never played as a duplicate', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    // No 'start': the source refused the track outright. The end still has to
    // advance the queue — a track that never produced a frame is exactly the
    // case the duplicate guard must not swallow, or one unplayable song would
    // end the session.
    h.player.emit('end', {
      reason: 'loadFailed',
      track: lavalinkEventTrack('encoded-t1', 0),
    });
    await settle();

    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
  });
});

describe('GuildPlayer playback controls', () => {
  it('pauses and resumes through the node', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'One')]);

    await h.gp.pause();
    expect(h.player.setPaused).toHaveBeenCalledWith(true);
    expect(h.gp.paused).toBe(true);

    await h.gp.resume();
    expect(h.player.setPaused).toHaveBeenLastCalledWith(false);
    expect(h.gp.paused).toBe(false);
  });

  it('sets volume and seeks on the node', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'One')]);

    await h.gp.setVolume(42);
    expect(h.player.setGlobalVolume).toHaveBeenCalledWith(42);
    expect(h.gp.volume).toBe(42);

    await h.gp.seekTo(30_000);
    expect(h.player.seekTo).toHaveBeenCalledWith(30_000);
  });

  it('replays the same track on a natural end in track-loop mode', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'One'), track('t2', 'Two')]);
    h.gp.setLoopMode('track');

    endNaturally(h.player);
    await settle();

    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t1']);
    expect(h.gp.queue.currentIndex).toBe(0);
  });

  it('skips through stopTrack and advances on the end it provokes', async () => {
    const h = harness();
    await h.gp.enqueue([track('t1', 'One'), track('t2', 'Two')]);

    await h.gp.skip();
    expect(h.player.stopTrack).toHaveBeenCalledTimes(1);
    await settle();

    expect(h.gp.queue.current?.identifier).toBe('t2');
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-t2']);
    // A real skip is a rejection, and must be recorded as one.
    expect(h.store.recordHistory).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({ identifier: 't1' }),
      expect.objectContaining({ skipped: true }),
    );
  });
});

/* ------------------------------------------------- autoplay failure fixtures */

interface FakeChannel {
  readonly isSendable: () => boolean;
  readonly send: ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;
}

/**
 * Make the bound text channel accept messages, so the notices the player sends
 * can be counted. The default harness resolves the fetch to null, which is
 * enough to prove "something was announced" but not WHAT, or how often.
 */
function sendableChannel(h: Harness): FakeChannel {
  const channel: FakeChannel = {
    isSendable: () => true,
    send: vi.fn((_payload: unknown) => Promise.resolve()),
  };
  // The harness types the fetch as returning null; a sendable channel is
  // exactly the shape `#notify` reaches for, so the cast is the whole point.
  h.fetchChannel.mockImplementation(() => Promise.resolve(channel as unknown as null));
  return channel;
}

/** How many plain-text notices containing `needle` went out. */
function countNotices(channel: FakeChannel, needle: string): number {
  return channel.send.mock.calls.filter(
    ([payload]) => typeof payload === 'string' && payload.includes(needle),
  ).length;
}

/**
 * `settle()` for fake-timer tests: each tick yields to the real event loop, so
 * the chained awaits in the end and refill handlers all get to run without any
 * fake clock time passing.
 */
async function tick(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** A promise the test decides when to settle, plus its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settleWith) => {
    resolve = settleWith;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
    },
  };
}

describe('GuildPlayer drain-time autoplay coordination', () => {
  it('waits for an in-flight refill instead of ending the queue', async () => {
    const refill = deferred<readonly QueuedTrack[]>();
    let issued = 0;
    const h = harness({
      autoplayEnabled: true,
      lowWaterMark: 2,
      targetQueueSize: 4,
      autoplay: () => {
        issued += 1;
        // Only the first request hangs; anything after it ends the refill loop.
        return issued === 1 ? refill.promise : Promise.resolve([]);
      },
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();
    expect(h.autoplay).toHaveBeenCalledTimes(1);

    // The track runs out while the low-water refill is still on its way.
    endNaturally(h.player);
    await settle();

    // A refill in flight is not an empty pool: the drain waits for it rather
    // than issuing a competing request or declaring the queue finished.
    expect(h.autoplay).toHaveBeenCalledTimes(1);
    expect(h.fetchChannel).not.toHaveBeenCalled();
    expect(played(h.player)).toEqual(['encoded-t1']);

    refill.resolve(picks(4));
    await settle();

    expect(h.gp.queue.current?.identifier).toBe('auto-0');
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-auto-0']);
    expect(h.gp.isPlaying).toBe(true);
  });

  it('never starts a refill itself while the end handler is mid-flight', async () => {
    vi.useFakeTimers();
    try {
      const refill = deferred<readonly QueuedTrack[]>();
      let issued = 0;
      const h = harness({
        autoplayEnabled: true,
        lowWaterMark: 2,
        targetQueueSize: 4,
        autoplay: (_guildId, count) => {
          issued += 1;
          return issued === 1
            ? refill.promise
            : Promise.resolve(picks(count, `late-${String(issued)}`));
        },
      });
      // Hold the end handler inside its history wait, which is the window the
      // refill has to land in for this to be a test of anything.
      const history = deferred<undefined>();
      h.store.recordHistory.mockImplementation(() => history.promise);

      await h.gp.enqueue([track('t1', 'Song One')]);
      h.player.emit('start');
      await tick();
      expect(h.autoplay).toHaveBeenCalledTimes(1);

      endNaturally(h.player);
      await tick();
      expect(h.store.recordHistory).toHaveBeenCalledTimes(1);

      refill.resolve(picks(4));
      await tick();

      // The picks are queued, but nothing was handed to Lavalink: while the
      // end handler runs it owns the decision about what plays next.
      expect(h.gp.queue.upcoming.length).toBeGreaterThan(0);
      expect(played(h.player)).toEqual(['encoded-t1']);

      history.resolve(undefined);
      await tick();

      // Exactly one further start, and for the head of the refilled queue.
      expect(played(h.player)).toEqual(['encoded-t1', 'encoded-auto-0']);
      expect(h.gp.queue.current?.identifier).toBe('auto-0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a slow history write and asks for music anyway', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        autoplayEnabled: true,
        autoplay: (_guildId, count) => Promise.resolve(picks(count)),
      });
      // A database that never answers. Autoplay wants the finished track in
      // history, but not at the price of an open-ended silence.
      h.store.recordHistory.mockImplementation(() => new Promise<undefined>(() => undefined));

      await h.gp.enqueue([track('t1', 'Song One')]);
      endNaturally(h.player);
      await tick();

      expect(h.autoplay).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_400);
      await tick();
      expect(h.autoplay).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await tick();

      expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
      expect(played(h.player)).toEqual(['encoded-t1', 'encoded-auto-0']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GuildPlayer autoplay failure handling', () => {
  it('retries a failing request exactly once and says so exactly once', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        autoplayEnabled: true,
        autoplay: () => Promise.reject(new Error('recommender unavailable')),
      });
      const channel = sendableChannel(h);

      await h.gp.enqueue([track('t1', 'Song One')]);
      endNaturally(h.player);
      await tick();

      // A failure is not the end of the queue, and must not be announced as one.
      expect(h.autoplay).toHaveBeenCalledTimes(1);
      expect(countNotices(channel, "couldn't prepare")).toBe(1);
      expect(countNotices(channel, 'Queue finished')).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(h.autoplay).toHaveBeenCalledTimes(2);

      // A persistent outage must not turn into a retry loop or a wall of text.
      await vi.advanceTimersByTimeAsync(30_000);
      await tick();

      expect(h.autoplay).toHaveBeenCalledTimes(2);
      expect(countNotices(channel, "couldn't prepare")).toBe(1);
      expect(countNotices(channel, 'Queue finished')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands every failure that follows a track start its own retry', async () => {
    vi.useFakeTimers();
    try {
      let issued = 0;
      const h = harness({
        autoplayEnabled: true,
        lowWaterMark: 2,
        targetQueueSize: 4,
        autoplay: () => {
          issued += 1;
          // Only the first retry delivers: every other request throws, so the
          // second drain has to earn a retry of its own.
          return issued === 2
            ? Promise.resolve([pick('rescued')])
            : Promise.reject(new Error('recommender unavailable'));
        },
      });
      const channel = sendableChannel(h);

      await h.gp.enqueue([track('t1', 'Song One')]);
      endNaturally(h.player);
      await tick();
      expect(h.autoplay).toHaveBeenCalledTimes(1);
      expect(countNotices(channel, "couldn't prepare")).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(played(h.player)).toEqual(['encoded-t1', 'encoded-rescued']);

      // Lavalink confirming the track is what clears the retry budget.
      h.player.emit('start');
      await tick();
      // The low-water refill fires on 'start' and fails too, but a top-up is
      // not a drain: it spends no retry and tells the channel nothing.
      expect(h.autoplay).toHaveBeenCalledTimes(3);
      expect(countNotices(channel, "couldn't prepare")).toBe(1);

      endNaturally(h.player);
      await tick();

      expect(h.autoplay).toHaveBeenCalledTimes(4);
      expect(countNotices(channel, "couldn't prepare")).toBe(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(h.autoplay).toHaveBeenCalledTimes(5);
      expect(countNotices(channel, 'Queue finished')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a request that never answers as a failure, and recovers after it', async () => {
    vi.useFakeTimers();
    try {
      let issued = 0;
      const h = harness({
        autoplayEnabled: true,
        autoplay: (_guildId, count) => {
          issued += 1;
          return issued === 1
            ? new Promise<readonly QueuedTrack[]>(() => undefined)
            : Promise.resolve(picks(count, 'after-timeout'));
        },
      });
      const channel = sendableChannel(h);

      await h.gp.enqueue([track('t1', 'Song One')]);
      endNaturally(h.player);
      await tick();

      // Still inside the deadline: nothing has been decided yet.
      expect(h.autoplay).toHaveBeenCalledTimes(1);
      expect(countNotices(channel, "couldn't prepare")).toBe(0);

      await vi.advanceTimersByTimeAsync(45_000);
      await tick();

      expect(countNotices(channel, "couldn't prepare")).toBe(1);
      expect(played(h.player)).toEqual(['encoded-t1']);

      await vi.advanceTimersByTimeAsync(5_000);
      await tick();

      // The hung request left no in-flight marker behind: the retry could ask
      // again, and the answer got the music going.
      expect(h.autoplay).toHaveBeenCalledTimes(2);
      expect(played(h.player)).toEqual(['encoded-t1', 'encoded-after-timeout-0']);
      expect(h.gp.queue.current?.identifier).toBe('after-timeout-0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GuildPlayer autoplay after parking and stopping', () => {
  it('restarts a parked player when autoplay is switched on', async () => {
    const h = harness({
      autoplayEnabled: false,
      autoplay: (_guildId, count) => Promise.resolve(picks(count, 'restart')),
    });

    await h.gp.enqueue([track('t1', 'Song One')]);
    endNaturally(h.player);
    await settle();

    // Parked: the queue finished with autoplay off, so nothing was asked for.
    expect(h.autoplay).not.toHaveBeenCalled();
    expect(h.gp.isPlaying).toBe(false);

    h.gp.setAutoplayEnabled(true);
    await settle();

    // Switching autoplay on right after "queue finished" is the likeliest
    // moment for it: a parked player has nothing to top up, it needs starting.
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(played(h.player)).toEqual(['encoded-t1', 'encoded-restart-0']);
    expect(h.gp.queue.current?.identifier).toBe('restart-0');
    expect(h.gp.isPlaying).toBe(true);
  });

  it('does not let a stop on an idle player suppress the next natural drain', async () => {
    const h = harness({ autoplayEnabled: true, autoplay: () => Promise.resolve([]) });
    // Nothing is playing, so a real node answers the stop with silence rather
    // than an end event; the shared fake would otherwise invent one for a
    // track that never played.
    h.player.stopTrack.mockImplementationOnce(() => Promise.resolve());

    await h.gp.stop();
    await settle();
    expect(h.gp.isPlaying).toBe(false);

    await h.gp.enqueue([track('t1', 'Song One')]);
    h.player.emit('start');
    await settle();
    // The low-water refill has nothing to give, so the queue really does drain.
    expect(h.autoplay).toHaveBeenCalledTimes(1);

    endNaturally(h.player);
    await settle();

    // The drain asked for music: the idle stop never armed the flag that
    // cancels autoplay, so it could not linger to kill this session.
    expect(h.autoplay).toHaveBeenCalledTimes(2);
    expect(h.fetchChannel).toHaveBeenCalledWith('text-1');
  });
});

describe('GuildPlayer listener identity', () => {
  it('adopts the first person who requests a track as the primary listener', async () => {
    const h = harness();
    const requested: QueuedTrack = { ...track('t1', 'One'), requestedById: '111111111111111111' };
    expect(h.gp.listenerId).toBeNull();

    await h.gp.enqueue([requested]);
    await h.gp.enqueue([{ ...track('t2', 'Two'), requestedById: '222222222222222222' }]);

    // First requester keeps the session; a later request does not steal it.
    expect(h.gp.listenerId).toBe('111111111111111111');
    expect(h.store.scheduleSave).toHaveBeenLastCalledWith(
      'guild-1',
      expect.anything(),
      expect.objectContaining({ listenerId: '111111111111111111' }),
    );
  });

  it('ignores autoplay picks and restored placeholders when choosing a listener', async () => {
    const h = harness();
    await h.gp.enqueue([
      track('a1', 'Auto', 'autoplay'),
      { ...track('r1', 'Restored'), requestedById: '0' },
    ]);
    expect(h.gp.listenerId).toBeNull();
  });

  it('changes hands only through an explicit claim, and reports it', async () => {
    const h = harness();
    await h.gp.enqueue([{ ...track('t1', 'One'), requestedById: '111111111111111111' }]);
    h.gp.setListener('333333333333333333');
    expect(h.gp.listenerId).toBe('333333333333333333');
    expect(h.gp.snapshot().listenerId).toBe('333333333333333333');
  });

  it('resumes a parked queue through autoplay without a new request', async () => {
    const h = harness({
      autoplayEnabled: true,
      autoplay: (_g, count) => Promise.resolve(picks(count)),
    });
    // A restored queue whose cursor is past its end: nothing to play.
    h.gp.queue.restore([track('old', 'Old')], 0, 'off');
    h.gp.queue.skip();
    expect(h.gp.queue.current).toBeNull();

    const resumed = await h.gp.resumeAutoplay();
    await settle();

    expect(resumed).toBe(true);
    expect(h.autoplay).toHaveBeenCalledWith('guild-1', 4);
    expect(played(h.player).length).toBeGreaterThan(0);
  });

  it('exposes the canonical track key in snapshots for dashboard actions', async () => {
    const h = harness();
    await h.gp.enqueue([{ ...track('t1', 'Blinding Lights'), author: 'The Weeknd' }]);
    expect(h.gp.snapshot().current?.trackKey).toBe('weeknd::blinding lights');
  });
});

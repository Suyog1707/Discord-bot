import type { Redis } from '@discord-music/shared/redis';
import { describe, expect, it } from 'vitest';

import type { AutoplayKind } from './interleave.js';
import { AutoplaySessionStore, computeArtistFatigue, type SessionEntry } from './session.js';

function entry(key: string, artistKey = 'artist', identifier = ''): SessionEntry {
  return { key, identifier, artistKey };
}

/** An autoplay pick that recorded which half of the cadence it filled. */
function autoplayEntry(key: string, kind: AutoplayKind): SessionEntry {
  return { key, identifier: '', artistKey: 'artist', origin: 'autoplay', kind };
}

/** A track someone actually asked for. */
function userEntry(key: string, requestedById: string): SessionEntry {
  return { key, identifier: '', artistKey: 'artist', origin: 'user', requestedById };
}

/**
 * A tiny in-memory Redis, just enough of ioredis's surface for session.ts:
 * get/set(+NX)/lrange/del/hgetall, plus a multi() pipeline supporting
 * lpush/ltrim/expire/del/hincrby. TTLs are not modelled — tests that need
 * expiry drive the store's injectable `now` instead, which is what the store
 * itself uses to decide reservation expiry.
 */
class WorkingFakeRedis {
  readonly #strings = new Map<string, string>();
  readonly #lists = new Map<string, string[]>();
  readonly #hashes = new Map<string, Map<string, number>>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#strings.get(key) ?? null);
  }

  set(key: string, value: string, ...rest: readonly unknown[]): Promise<'OK' | null> {
    if (rest.includes('NX') && this.#strings.has(key)) return Promise.resolve(null);
    this.#strings.set(key, value);
    return Promise.resolve('OK');
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.#lists.get(key) ?? [];
    return Promise.resolve(list.slice(start, stop === -1 ? undefined : stop + 1));
  }

  del(...keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.#strings.delete(key)) removed += 1;
      if (this.#lists.delete(key)) removed += 1;
      if (this.#hashes.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.#hashes.get(key);
    const record: Record<string, string> = {};
    if (hash !== undefined) {
      for (const [field, value] of hash) record[field] = String(value);
    }
    return Promise.resolve(record);
  }

  multi(): FakeMultiChain {
    const ops: (() => void)[] = [];
    const chain: FakeMultiChain = {
      lpush: (key, value) => {
        ops.push(() => {
          const list = this.#lists.get(key) ?? [];
          list.unshift(value);
          this.#lists.set(key, list);
        });
        return chain;
      },
      ltrim: (key, start, stop) => {
        ops.push(() => {
          const list = this.#lists.get(key) ?? [];
          this.#lists.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
        });
        return chain;
      },
      expire: (_key, _seconds) => chain,
      del: (key) => {
        ops.push(() => {
          this.#strings.delete(key);
          this.#lists.delete(key);
          this.#hashes.delete(key);
        });
        return chain;
      },
      hincrby: (key, field, amount) => {
        ops.push(() => {
          const hash = this.#hashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + amount);
          this.#hashes.set(key, hash);
        });
        return chain;
      },
      exec: () => {
        for (const op of ops) op();
        return Promise.resolve(null);
      },
    };
    return chain;
  }
}

interface FakeMultiChain {
  lpush(key: string, value: string): FakeMultiChain;
  ltrim(key: string, start: number, stop: number): FakeMultiChain;
  expire(key: string, seconds: number): FakeMultiChain;
  del(key: string): FakeMultiChain;
  hincrby(key: string, field: string, amount: number): FakeMultiChain;
  exec(): Promise<null>;
}

/** Every real operation rejects, exactly like a Redis instance that is down. */
function rejectingRedis(): Redis {
  const reject = (..._args: readonly unknown[]): Promise<never> =>
    Promise.reject(new Error('redis unavailable'));
  const chain = {
    lpush: () => chain,
    ltrim: () => chain,
    expire: () => chain,
    del: () => chain,
    hincrby: () => chain,
    exec: reject,
  };
  return {
    get: reject,
    set: reject,
    lrange: reject,
    del: reject,
    hgetall: reject,
    multi: () => chain,
  } as unknown as Redis;
}

describe('AutoplaySessionStore — reservations', () => {
  // The bug this store exists to prevent: two in-flight recommendation passes
  // both landing on the same track because nothing reserved it between "picked"
  // and "queued". Two concurrent reserve() calls must never both win a key.
  it('grants disjoint keys to two concurrent reserve() calls with overlapping requests', async () => {
    const store = new AutoplaySessionStore();

    const [a, b] = await Promise.all([
      store.reserve('guild', ['x', 'y', 'z']),
      store.reserve('guild', ['y', 'z', 'w']),
    ]);

    for (const key of a) expect(b.has(key)).toBe(false);
    const union = new Set([...a, ...b]);
    expect(union).toEqual(new Set(['x', 'y', 'z', 'w']));
  });

  it('makes a key reservable again after release', async () => {
    const store = new AutoplaySessionStore();

    const first = await store.reserve('guild', ['a']);
    expect(first.has('a')).toBe(true);

    const whileHeld = await store.reserve('guild', ['a']);
    expect(whileHeld.has('a')).toBe(false);

    await store.release('guild', ['a']);
    const afterRelease = await store.reserve('guild', ['a']);
    expect(afterRelease.has('a')).toBe(true);
  });

  it('lets a reservation expire on its own once the TTL passes', async () => {
    let now = 0;
    const store = new AutoplaySessionStore({ reservationTtlSeconds: 60, now: () => now });

    expect((await store.reserve('guild', ['a'])).has('a')).toBe(true);
    // Still within the 60s window: someone else already holds it.
    expect((await store.reserve('guild', ['a'])).has('a')).toBe(false);

    now += 61_000;
    expect((await store.reserve('guild', ['a'])).has('a')).toBe(true);
  });

  // The mechanism, spelled out: same-process races are serialised by a
  // synchronous check-and-set with no `await` in between, and a real Redis
  // instance shared across two "processes" (two store instances here) is the
  // one thing that can arbitrate beyond a single process's memory.
  it('arbitrates a reservation race between two store instances sharing Redis', async () => {
    const redis = new WorkingFakeRedis() as unknown as Redis;
    const storeA = new AutoplaySessionStore({ redis });
    const storeB = new AutoplaySessionStore({ redis });

    const [a, b] = await Promise.all([
      storeA.reserve('guild', ['shared']),
      storeB.reserve('guild', ['shared']),
    ]);

    expect(a.has('shared')).toBe(true);
    expect(b.has('shared')).toBe(false);
  });
});

describe('AutoplaySessionStore — recordPlayed', () => {
  it('pushes newest first and trims recent history to the configured limit', async () => {
    const store = new AutoplaySessionStore({ recentLimit: 3 });

    for (const key of ['s1', 's2', 's3', 's4']) {
      await store.recordPlayed('guild', entry(key));
    }

    const snap = await store.snapshot('guild');
    expect(snap.recentKeys).toEqual(['s4', 's3', 's2']);
  });

  it('drops the played track from the queued and reserved sets', async () => {
    const store = new AutoplaySessionStore();
    await store.syncQueue('guild', [entry('s1'), entry('s2')]);
    await store.reserve('guild', ['s1']);

    await store.recordPlayed('guild', entry('s1'));

    const snap = await store.snapshot('guild');
    expect(snap.queuedKeys.has('s1')).toBe(false);
    expect(snap.queuedKeys.has('s2')).toBe(true);
    expect(snap.reservedKeys.has('s1')).toBe(false);
  });
});

describe('AutoplaySessionStore — syncQueue', () => {
  it('replaces the queued set wholesale rather than merging', async () => {
    const store = new AutoplaySessionStore();
    await store.syncQueue('guild', [entry('old1'), entry('old2')]);

    await store.syncQueue('guild', [entry('new1')]);

    const snap = await store.snapshot('guild');
    expect(snap.queuedKeys).toEqual(new Set(['new1']));
  });
});

describe('AutoplaySessionStore — snapshot', () => {
  it('exposes recent/queued/reserved sets and per-artist fatigue', async () => {
    const store = new AutoplaySessionStore();
    await store.syncQueue('guild', [entry('q1'), entry('q2')]);
    await store.reserve('guild', ['r1']);
    await store.recordPlayed('guild', entry('t1', 'a'));
    await store.recordPlayed('guild', entry('t2', 'b'));
    await store.recordPlayed('guild', entry('t3', 'a'));

    const snap = await store.snapshot('guild');

    expect(snap.queuedKeys).toEqual(new Set(['q1', 'q2']));
    expect(snap.reservedKeys).toEqual(new Set(['r1']));
    expect(snap.recentArtists).toEqual(['a', 'b', 'a']);
    expect(snap.artistFatigue.get('a') ?? 0).toBeGreaterThan(snap.artistFatigue.get('b') ?? 0);
  });

  it('keeps an unknown ("") identifier out of queuedIdentifiers but preserves it in recentIdentifiers', async () => {
    const store = new AutoplaySessionStore();
    await store.syncQueue('guild', [entry('q1', 'artist', ''), entry('q2', 'artist', 'yt2')]);
    await store.recordPlayed('guild', entry('t1', 'artist', ''));

    const snap = await store.snapshot('guild');
    expect(snap.queuedIdentifiers).toEqual(new Set(['yt2']));
    expect(snap.recentIdentifiers).toEqual(['']);
  });
});

describe('computeArtistFatigue', () => {
  it('scores the most recent play at (clamped) 1.0', () => {
    expect(computeArtistFatigue(['a']).get('a')).toBeCloseTo(1, 5);
  });

  it('decays monotonically the further back a single play sits', () => {
    const at = (index: number): number => {
      const artists = [...Array.from({ length: index }, (_, i) => `filler${String(i)}`), 'a'];
      return computeArtistFatigue(artists).get('a') ?? 0;
    };

    expect(at(0)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(5));
    expect(at(5)).toBeGreaterThan(at(10));
  });

  it('matches the documented decay at index 10 (tau = 6, ~0.19)', () => {
    const artists = [...Array.from({ length: 10 }, (_, i) => `filler${String(i)}`), 'a'];
    expect(computeArtistFatigue(artists).get('a')).toBeCloseTo(0.1889, 3);
  });

  // Clamped occurrences at index 0 would make "twice" and "once" both read as
  // 1.0, so this compares two unclamped placements to isolate the effect that
  // matters in practice: an artist heard twice in the last several tracks
  // should read hotter than one heard once a while back.
  it('rates an artist played twice recently above one played once long ago', () => {
    const twiceRecently = computeArtistFatigue([
      'filler0',
      'filler1',
      'filler2',
      'filler3',
      'filler4',
      'x',
      'filler6',
      'x',
    ]).get('x');
    const onceLongAgo = computeArtistFatigue([
      'filler0',
      'filler1',
      'filler2',
      'filler3',
      'filler4',
      'filler5',
      'filler6',
      'filler7',
      'filler8',
      'filler9',
      'filler10',
      'x',
    ]).get('x');

    expect(twiceRecently ?? 0).toBeGreaterThan(onceLongAgo ?? 0);
  });

  it('leaves an artist that never played absent from the map', () => {
    const fatigue = computeArtistFatigue(['a', 'b']);
    expect(fatigue.has('unknown-artist')).toBe(false);
  });
});

describe('AutoplaySessionStore — Redis failure fallback', () => {
  // A cache-style guarantee: Redis is an optimisation, so losing it must never
  // break autoplay. Every method here still has to work purely off memory.
  it('falls back to memory when every Redis call rejects, and counts the errors', async () => {
    const store = new AutoplaySessionStore({ redis: rejectingRedis() });

    await store.syncQueue('guild', [entry('s1')]);
    await store.recordPlayed('guild', entry('s2'));
    await store.recordOutcome('guild', 'played');
    const granted = await store.reserve('guild', ['s3']);
    await store.release('guild', ['s3']);

    const snap = await store.snapshot('guild');

    expect(granted.has('s3')).toBe(true);
    expect(snap.recentKeys).toEqual(['s2']);
    expect(snap.queuedKeys).toEqual(new Set(['s1']));
    expect(snap.outcomes.played).toBe(1);
    expect(store.redisErrors).toBeGreaterThan(0);
  });
});

describe('AutoplaySessionStore — clear', () => {
  it('clears one guild without touching another', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guildA', entry('a1'));
    await store.recordPlayed('guildB', entry('b1'));

    await store.clear('guildA');

    const snapA = await store.snapshot('guildA');
    const snapB = await store.snapshot('guildB');
    expect(snapA.recentKeys).toEqual([]);
    expect(snapB.recentKeys).toEqual(['b1']);
  });
});

describe('AutoplaySessionStore — outcomes', () => {
  it('increments outcome counters, including duplicatesBlocked', async () => {
    const store = new AutoplaySessionStore();

    await store.recordOutcome('guild', 'recommended', 5);
    await store.recordOutcome('guild', 'played');
    await store.recordOutcome('guild', 'played');
    await store.recordOutcome('guild', 'duplicatesBlocked');

    const snap = await store.snapshot('guild');
    expect(snap.outcomes.recommended).toBe(5);
    expect(snap.outcomes.played).toBe(2);
    expect(snap.outcomes.duplicatesBlocked).toBe(1);
    expect(snap.outcomes.skipped).toBe(0);
  });
});

describe('AutoplaySessionStore — Redis write-through', () => {
  it('persists recent plays and the queued set so a fresh store instance can read them back', async () => {
    const redis = new WorkingFakeRedis() as unknown as Redis;
    const first = new AutoplaySessionStore({ redis });
    await first.recordPlayed('guild', entry('s1'));
    await first.syncQueue('guild', [entry('s2')]);

    // A fresh store with empty memory, same Redis — simulates surviving a restart.
    const second = new AutoplaySessionStore({ redis });
    const snap = await second.snapshot('guild');

    expect(snap.recentKeys).toEqual(['s1']);
    expect(snap.queuedKeys.has('s2')).toBe(true);
  });
});

describe('AutoplaySessionStore — autoplay cadence', () => {
  // The ordering is the whole point: `queued` runs in PLAY order, so its last
  // element is the newest decision, while `recent` is already newest-first.
  // Getting this backwards would make the planner read a finished run as if it
  // had just started.
  it('reports queued kinds last-queued-first, ahead of recent plays newest-first', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', autoplayEntry('p1', 'familiar'));
    await store.recordPlayed('guild', autoplayEntry('p2', 'discovery'));
    await store.syncQueue('guild', [
      autoplayEntry('q1', 'familiar'),
      autoplayEntry('q2', 'discovery'),
    ]);

    const snap = await store.snapshot('guild');

    expect(snap.recentAutoplayKinds).toEqual(['discovery', 'familiar', 'discovery', 'familiar']);
  });

  // The playing track is in BOTH lists: `recordPlayed` put it at the head of
  // recent, and the queue mirror (which includes the current track) puts it
  // at the head of queued. Counted twice the run would read one longer than
  // it is and a discovery would land a beat early.
  it('does not count the currently playing track twice when it is in recent and queued', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', autoplayEntry('p1', 'familiar'));
    await store.recordPlayed('guild', autoplayEntry('p2', 'familiar'));
    await store.syncQueue('guild', [
      autoplayEntry('p2', 'familiar'),
      autoplayEntry('q1', 'familiar'),
    ]);

    const snap = await store.snapshot('guild');

    expect(snap.recentAutoplayKinds).toEqual(['familiar', 'familiar', 'familiar']);
  });

  it('stamps playedAt on recorded plays and exposes the timed ring as recentEntries', async () => {
    let clock = 1_000_000;
    const store = new AutoplaySessionStore({ now: () => clock });
    await store.recordPlayed('guild', entry('p1'));
    clock += 60_000;
    await store.recordPlayed('guild', entry('p2'));

    const snap = await store.snapshot('guild');

    expect(snap.recentEntries.map((item) => item.key)).toEqual(['p2', 'p1']);
    expect(snap.recentEntries[0]?.playedAt).toBe(1_060_000);
    expect(snap.recentEntries[1]?.playedAt).toBe(1_000_000);
  });

  it('remembers dislikes for the session and drops any reservation on them', async () => {
    const store = new AutoplaySessionStore();
    await store.reserve('guild', ['bad']);
    await store.recordDisliked('guild', ['bad']);

    const snap = await store.snapshot('guild');

    expect(snap.dislikedKeys.has('bad')).toBe(true);
    expect(snap.reservedKeys.has('bad')).toBe(false);
  });

  it('puts the primary listener first, ahead of whoever requested most recently', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', userEntry('p1', '222222222222222222'));
    await store.setListener('guild', '111111111111111111');

    const snap = await store.snapshot('guild');

    expect(snap.primaryListenerId).toBe('111111111111111111');
    expect(snap.listenerIds).toEqual(['111111111111111111', '222222222222222222']);
  });

  it('forgets a dislike so a forgiven song is eligible again this session', async () => {
    const store = new AutoplaySessionStore();
    await store.recordDisliked('guild', ['bad', 'worse']);
    await store.forgetDisliked('guild', ['bad']);

    const snap = await store.snapshot('guild');

    expect(snap.dislikedKeys.has('bad')).toBe(false);
    expect(snap.dislikedKeys.has('worse')).toBe(true);
  });

  it('ignores entries with no kind, so user requests never break a familiar run', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', autoplayEntry('p1', 'familiar'));
    await store.recordPlayed('guild', userEntry('p2', '111111111111111111'));
    await store.recordPlayed('guild', autoplayEntry('p3', 'familiar'));
    await store.syncQueue('guild', [userEntry('q1', '111111111111111111')]);

    const snap = await store.snapshot('guild');

    expect(snap.recentAutoplayKinds).toEqual(['familiar', 'familiar']);
  });

  // Backwards compatibility: sessions written before the cadence existed, and
  // every caller that does not care about it, must still snapshot cleanly.
  it('leaves the cadence empty for entries that carry none of the new fields', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', entry('p1'));
    await store.syncQueue('guild', [entry('q1')]);

    const snap = await store.snapshot('guild');

    expect(snap.recentAutoplayKinds).toEqual([]);
    expect(snap.listenerIds).toEqual([]);
  });

  it('carries kind and requester through Redis so a restart keeps the cadence', async () => {
    const redis = new WorkingFakeRedis() as unknown as Redis;
    const first = new AutoplaySessionStore({ redis });
    await first.recordPlayed('guild', autoplayEntry('p1', 'discovery'));
    await first.syncQueue('guild', [userEntry('q1', '111111111111111111')]);

    const second = new AutoplaySessionStore({ redis });
    const snap = await second.snapshot('guild');

    expect(snap.recentAutoplayKinds).toEqual(['discovery']);
    expect(snap.listenerIds).toEqual(['111111111111111111']);
  });
});

describe('AutoplaySessionStore — listeners', () => {
  it('lists distinct requesters, recent plays before the queue', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', userEntry('p1', 'user-a'));
    await store.recordPlayed('guild', userEntry('p2', 'user-b'));
    // The same person again: newest position wins, and they appear once.
    await store.recordPlayed('guild', userEntry('p3', 'user-a'));
    await store.syncQueue('guild', [userEntry('q1', 'user-c'), userEntry('q2', 'user-b')]);

    const snap = await store.snapshot('guild');

    expect(snap.listenerIds).toEqual(['user-a', 'user-b', 'user-c']);
  });

  it('ignores autoplay entries and placeholder requester ids', async () => {
    const store = new AutoplaySessionStore();
    await store.recordPlayed('guild', autoplayEntry('p1', 'familiar'));
    await store.recordPlayed('guild', { ...userEntry('p2', '0') });
    await store.recordPlayed('guild', { ...userEntry('p3', '') });
    await store.recordPlayed('guild', userEntry('p4', 'user-a'));

    const snap = await store.snapshot('guild');

    expect(snap.listenerIds).toEqual(['user-a']);
  });

  it('caps the listener list at five', async () => {
    const store = new AutoplaySessionStore();
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await store.recordPlayed('guild', userEntry(`p${String(index)}`, `user-${String(index)}`));
    }

    const snap = await store.snapshot('guild');

    expect(snap.listenerIds).toEqual(['user-6', 'user-5', 'user-4', 'user-3', 'user-2']);
  });
});

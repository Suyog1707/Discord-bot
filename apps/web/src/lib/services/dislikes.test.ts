import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DatabaseModule from '@discord-music/database';
import {
  decodePlayerCommand,
  PLAYER_COMMAND_CHANNEL,
  ValidationError,
} from '@discord-music/shared';

/** A `disliked_tracks` row, as the fake below stores it. */
interface FakeRow {
  readonly id: string;
  readonly userId: string;
  readonly trackKey: string;
  readonly title: string;
  readonly author: string;
  readonly isrc: string | null;
  readonly source: string;
  readonly createdAt: Date;
}

interface FindManyArgs {
  readonly where: { readonly user: { readonly discordId: string } };
  readonly take: number;
  readonly cursor?: { readonly id: string };
  readonly skip?: number;
}

interface DeleteManyArgs {
  readonly where: {
    readonly user: { readonly discordId: string };
    readonly trackKey: { readonly in: readonly string[] };
  };
}

/**
 * A `PrismaClient` stand-in for `disliked_tracks`.
 *
 * The pagination and bulk-delete logic under test is *made of* query shapes —
 * the ordering, the `cursor`/`skip` pair, the ownership `where`, the chunk size
 * — so mocking the database functions away would leave nothing to assert. This
 * fake answers the four calls they make and records the arguments, which is the
 * only place those shapes can actually be checked.
 *
 * It mirrors Prisma where the behaviour matters: `cursor` throws when the row
 * is not there, which is exactly the stale-cursor case the code must survive.
 */
const store = {
  rows: [] as FakeRow[],
  /** `userId` → Discord snowflake, standing in for the `User` relation. */
  owners: new Map<string, string>(),
};

/** Newest first, ties broken by id — the ordering the cursor resumes against. */
function sorted(rows: readonly FakeRow[]): FakeRow[] {
  return [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
  );
}

function ownedBy(discordId: string): FakeRow[] {
  return store.rows.filter((row) => store.owners.get(row.userId) === discordId);
}

const findMany = vi.fn((args: FindManyArgs): Promise<FakeRow[]> => {
  const rows = sorted(ownedBy(args.where.user.discordId));

  let start = 0;
  if (args.cursor !== undefined) {
    const at = rows.findIndex((row) => row.id === args.cursor?.id);
    if (at < 0) return Promise.reject(new Error('Prisma: cursor row not found'));
    start = at + (args.skip ?? 0);
  }
  return Promise.resolve(rows.slice(start, start + args.take));
});

const findUnique = vi.fn(
  (args: {
    readonly where: { readonly id: string };
  }): Promise<{ user: { discordId: string } } | null> => {
    const row = store.rows.find((candidate) => candidate.id === args.where.id);
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({ user: { discordId: store.owners.get(row.userId) ?? '' } });
  },
);

const count = vi.fn((args: FindManyArgs): Promise<number> =>
  Promise.resolve(ownedBy(args.where.user.discordId).length),
);

const deleteMany = vi.fn((args: DeleteManyArgs): Promise<{ count: number }> => {
  const keys = new Set(args.where.trackKey.in);
  const doomed = ownedBy(args.where.user.discordId).filter((row) => keys.has(row.trackKey));
  store.rows = store.rows.filter((row) => !doomed.includes(row));
  return Promise.resolve({ count: doomed.length });
});

const db = { dislikedTrack: { findMany, findUnique, count, deleteMany } };

const publish = vi.fn<(channel: string, payload: string) => Promise<number>>();
let redis: { publish: typeof publish } | undefined = { publish };

vi.mock('@/lib/db', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/logger', () => ({ getLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));

// Hoisted so the module factory below — which vitest lifts above every import —
// can hand back the very spies the assertions read.
const domain = vi.hoisted(() => ({
  addDislike: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  removeDislike: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  listDislikes: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

// Only the single-row helpers are stubbed. `pageDislikes`, `countDislikes` and
// `removeDislikes` stay real and run against the fake client above, because
// their behaviour *is* the query they build.
vi.mock('@discord-music/database', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  ...domain,
}));

const { addDislike, removeDislike, listDislikes: listDislikeRows } = domain;

const {
  addDislikeForUser,
  listDislikes,
  pageDislikesForUser,
  removeDislikeForUser,
  removeDislikesForUser,
} = await import('./dislikes');

const USER = { discordId: '123456789012345678', username: 'listener' };
const OTHER = { discordId: '222222222222222222' };
const GUILD_ID = '987654321098765432';

/** Seed `total` rows for a listener, oldest first, one minute apart. */
function seed(discordId: string, total: number, prefix = 'row'): void {
  const userId = `user-${discordId}`;
  store.owners.set(userId, discordId);
  for (let index = 0; index < total; index += 1) {
    store.rows.push({
      id: `${prefix}-${String(index).padStart(3, '0')}`,
      userId,
      trackKey: `artist::song-${String(index)}`,
      title: `Song ${String(index)}`,
      author: 'Artist',
      isrc: null,
      source: 'button',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
    });
  }
}

/** The single command this test published, decoded through the shared schema. */
function publishedCommand() {
  expect(publish).toHaveBeenCalledTimes(1);
  const [channel, payload] = publish.mock.calls[0] as [string, string];
  expect(channel).toBe(PLAYER_COMMAND_CHANNEL);
  return decodePlayerCommand(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.owners = new Map<string, string>();
  redis = { publish };
  publish.mockResolvedValue(1);
  addDislike.mockResolvedValue({ added: true, trackKey: 'artist::song' });
  removeDislike.mockResolvedValue(true);
  listDislikeRows.mockResolvedValue([]);
});

describe('addDislikeForUser', () => {
  it('persists through the shared domain, as a dashboard-sourced dislike', async () => {
    const result = await addDislikeForUser(USER, { title: 'Song', author: 'Artist' });

    expect(addDislike).toHaveBeenCalledWith(
      db,
      USER.discordId,
      USER.username,
      { title: 'Song', author: 'Artist' },
      'dashboard',
    );
    expect(result).toEqual({ added: true, trackKey: 'artist::song' });
  });

  it('publishes the dislike command when a guild is named', async () => {
    await addDislikeForUser(USER, {
      title: 'Song',
      author: 'Artist',
      guildId: GUILD_ID,
      skipIfPlaying: true,
    });

    // The stored key wins over anything the client sent: the row is the truth.
    expect(publishedCommand()).toEqual({
      action: 'dislike',
      guildId: GUILD_ID,
      issuedBy: USER.discordId,
      trackKey: 'artist::song',
      skipIfPlaying: true,
    });
  });

  it('stays silent when no guild is named', async () => {
    await addDislikeForUser(USER, { title: 'Song', author: 'Artist' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not throw when Redis is absent — the row is the dislike', async () => {
    redis = undefined;

    await expect(
      addDislikeForUser(USER, { title: 'Song', author: 'Artist', guildId: GUILD_ID }),
    ).resolves.toEqual({ added: true, trackKey: 'artist::song' });
  });

  it('does not throw when the publish itself fails', async () => {
    publish.mockRejectedValue(new Error('no bot listening'));

    await expect(
      addDislikeForUser(USER, { title: 'Song', author: 'Artist', guildId: GUILD_ID }),
    ).resolves.toEqual({ added: true, trackKey: 'artist::song' });
    expect(addDislike).toHaveBeenCalledOnce();
  });

  it('rejects a body with no title', async () => {
    await expect(addDislikeForUser(USER, { title: '', author: 'Artist' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(addDislike).not.toHaveBeenCalled();
  });
});

describe('removeDislikeForUser', () => {
  it('removes the row and tells the named guild to forget it', async () => {
    await expect(removeDislikeForUser(USER, 'artist::song', GUILD_ID)).resolves.toBe(true);

    expect(removeDislike).toHaveBeenCalledWith(db, USER.discordId, 'artist::song');
    expect(publishedCommand()).toEqual({
      action: 'undislike',
      guildId: GUILD_ID,
      issuedBy: USER.discordId,
      trackKey: 'artist::song',
    });
  });

  it('publishes nothing when the key was not this listener’s to remove', async () => {
    removeDislike.mockResolvedValue(false);

    await expect(removeDislikeForUser(USER, 'artist::song', GUILD_ID)).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('listDislikes', () => {
  it('maps rows to views, dropping the internal ids', async () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    listDislikeRows.mockResolvedValue([
      {
        id: 'row-1',
        userId: 'user-1',
        trackKey: 'artist::song',
        title: 'Song',
        author: 'Artist',
        isrc: 'USABC1234567',
        source: 'button',
        createdAt,
      },
    ]);

    await expect(listDislikes(USER)).resolves.toEqual([
      {
        trackKey: 'artist::song',
        title: 'Song',
        author: 'Artist',
        isrc: 'USABC1234567',
        source: 'button',
        createdAt,
      },
    ]);
    expect(listDislikeRows).toHaveBeenCalledWith(db, USER.discordId, 100);
  });
});

describe('pageDislikesForUser', () => {
  it('walks the whole list once, newest first, across three pages', async () => {
    seed(USER.discordId, 7);
    seed(OTHER.discordId, 3, 'other');

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Awaited<ReturnType<typeof pageDislikesForUser>> = await pageDislikesForUser(
        USER,
        cursor === null ? { limit: 3 } : { limit: 3, cursor },
      );
      pages += 1;
      seen.push(...page.items.map((item) => item.trackKey));
      cursor = page.nextCursor;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    // Every row exactly once, newest first, and nobody else's.
    expect(seen).toEqual([
      'artist::song-6',
      'artist::song-5',
      'artist::song-4',
      'artist::song-3',
      'artist::song-2',
      'artist::song-1',
      'artist::song-0',
    ]);
  });

  it('counts only on the first page', async () => {
    seed(USER.discordId, 7);

    const first = await pageDislikesForUser(USER, { limit: 3 });
    expect(first.total).toBe(7);
    expect(count).toHaveBeenCalledOnce();

    count.mockClear();
    const second = await pageDislikesForUser(USER, { limit: 3, cursor: first.nextCursor });
    expect(second.total).toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it('clamps the page size instead of rejecting it', async () => {
    seed(USER.discordId, 2);

    // take is limit + 1: the extra row is how "is there more" is answered.
    await pageDislikesForUser(USER, { limit: 5000 });
    expect(findMany.mock.calls[0]?.[0].take).toBe(101);

    await pageDislikesForUser(USER, { limit: 0 });
    expect(findMany.mock.calls[1]?.[0].take).toBe(2);

    await pageDislikesForUser(USER);
    expect(findMany.mock.calls[2]?.[0].take).toBe(51);
  });

  it('serves the first page again when the cursor row is gone', async () => {
    seed(USER.discordId, 4);
    const first = await pageDislikesForUser(USER, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    // The listener purged the rows this cursor points into before clicking
    // "Load more" — a stale cursor must restart the list, not fail it.
    store.rows = [];
    seed(USER.discordId, 2, 'fresh');
    findMany.mockClear();

    const stale = await pageDislikesForUser(USER, { limit: 2, cursor: first.nextCursor });

    expect(stale.items.map((item) => item.trackKey)).toEqual(['artist::song-1', 'artist::song-0']);
    expect(findMany.mock.calls[0]?.[0].cursor).toBeUndefined();
  });

  it('ignores a cursor pointing at another listener’s row', async () => {
    seed(USER.discordId, 3);
    seed(OTHER.discordId, 3, 'other');

    const page = await pageDislikesForUser(USER, { limit: 2, cursor: 'other-001' });

    // The ownership guard turns a guessed id into "start over" — it never
    // positions this listener's page from a stranger's row.
    expect(findMany.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(page.items.map((item) => item.trackKey)).toEqual(['artist::song-2', 'artist::song-1']);
  });
});

describe('removeDislikesForUser', () => {
  it('deletes only this listener’s rows', async () => {
    seed(USER.discordId, 2);
    seed(OTHER.discordId, 2, 'other');

    await expect(removeDislikesForUser(USER, ['artist::song-0', 'artist::song-1'])).resolves.toBe(
      2,
    );

    expect(deleteMany.mock.calls[0]?.[0].where.user).toEqual({ discordId: USER.discordId });
    // The other listener disliked the very same songs and keeps them.
    expect(store.rows.map((row) => row.id)).toEqual(['other-000', 'other-001']);
  });

  it('chunks a purge larger than one statement should carry', async () => {
    seed(USER.discordId, 250);
    const keys = Array.from({ length: 250 }, (_, index) => `artist::song-${String(index)}`);

    await expect(removeDislikesForUser(USER, keys)).resolves.toBe(250);

    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[0]?.[0].where.trackKey.in).toHaveLength(200);
    expect(deleteMany.mock.calls[1]?.[0].where.trackKey.in).toHaveLength(50);
  });

  it('does not query at all for an empty selection', async () => {
    await expect(removeDislikesForUser(USER, [], GUILD_ID)).resolves.toBe(0);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('tells a live player about a small removal, key by key', async () => {
    seed(USER.discordId, 3);

    await expect(
      removeDislikesForUser(USER, ['artist::song-0', 'artist::song-1'], GUILD_ID),
    ).resolves.toBe(2);

    expect(publish).toHaveBeenCalledTimes(2);
    const commands = publish.mock.calls.map(([, payload]) => decodePlayerCommand(payload));
    expect(commands).toEqual([
      {
        action: 'undislike',
        guildId: GUILD_ID,
        issuedBy: USER.discordId,
        trackKey: 'artist::song-0',
      },
      {
        action: 'undislike',
        guildId: GUILD_ID,
        issuedBy: USER.discordId,
        trackKey: 'artist::song-1',
      },
    ]);
  });

  it('stays quiet for a bulk purge — the planner re-reads the database', async () => {
    seed(USER.discordId, 50);
    const keys = Array.from({ length: 50 }, (_, index) => `artist::song-${String(index)}`);

    await expect(removeDislikesForUser(USER, keys, GUILD_ID)).resolves.toBe(50);

    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes nothing when none of the keys were this listener’s', async () => {
    seed(OTHER.discordId, 2, 'other');

    await expect(removeDislikesForUser(USER, ['artist::song-0'], GUILD_ID)).resolves.toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

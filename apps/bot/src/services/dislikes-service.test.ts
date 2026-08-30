import { Prisma, type PrismaClient } from '@discord-music/database';
import { describe, expect, it, vi } from 'vitest';

import { identityOf } from '../ai/identity.js';
import { DISLIKES_MAX_PER_USER, DislikesService } from './dislikes-service.js';

/**
 * Prisma is replaced by a small in-memory table rather than stubbed per call:
 * the interesting claims here ("the same song under two provider spellings is
 * one dislike", "keysFor unions the room") are about rows going in and coming
 * back out, and a per-call stub can only assert on the `where` clause it was
 * handed.
 */
interface Row {
  id: string;
  userId: string;
  trackKey: string;
  isrc: string | null;
  title: string;
  author: string;
  source: string;
  createdAt: Date;
}

/** The fake's user table is implicit: one row id derived from the snowflake. */
const userIdOf = (discordId: string): string => `user:${discordId}`;

interface UserFilter {
  readonly discordId?: string | { readonly in?: readonly string[] };
}

interface WhereArgs {
  readonly userId?: string;
  readonly trackKey?: string;
  readonly user?: UserFilter;
}

interface FindManyArgs {
  readonly where?: WhereArgs;
  readonly take?: number;
  readonly orderBy?: { readonly createdAt?: 'asc' | 'desc' };
}

interface CreateArgs {
  readonly data: {
    readonly userId: string;
    readonly trackKey: string;
    readonly isrc: string | null;
    readonly title: string;
    readonly author: string;
    readonly source: string;
  };
}

interface FindUniqueArgs {
  readonly where: {
    readonly userId_trackKey: { readonly userId: string; readonly trackKey: string };
  };
}

function matches(row: Row, where: WhereArgs | undefined): boolean {
  if (where === undefined) return true;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.trackKey !== undefined && row.trackKey !== where.trackKey) return false;

  const wanted = where.user?.discordId;
  if (wanted === undefined) return true;
  if (typeof wanted === 'string') return row.userId === userIdOf(wanted);
  return (wanted.in ?? []).some((discordId) => row.userId === userIdOf(discordId));
}

function fakePrisma(seed: readonly Row[] = []) {
  const rows: Row[] = [...seed];
  let nextId = seed.length;

  const stub = {
    user: {
      upsert: vi.fn((args: { where: { discordId: string } }) =>
        Promise.resolve({ id: userIdOf(args.where.discordId) }),
      ),
    },
    dislikedTrack: {
      count: vi.fn((args: FindManyArgs) =>
        Promise.resolve(rows.filter((row) => matches(row, args.where)).length),
      ),
      findUnique: vi.fn((args: FindUniqueArgs) => {
        const { userId, trackKey } = args.where.userId_trackKey;
        const hit = rows.find((row) => row.userId === userId && row.trackKey === trackKey);
        return Promise.resolve(hit === undefined ? null : { id: hit.id });
      }),
      create: vi.fn((args: CreateArgs) => {
        nextId += 1;
        const row: Row = { id: `row-${String(nextId)}`, createdAt: new Date(nextId), ...args.data };
        rows.push(row);
        return Promise.resolve(row);
      }),
      deleteMany: vi.fn((args: FindManyArgs) => {
        const kept = rows.filter((row) => !matches(row, args.where));
        const removed = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve({ count: removed });
      }),
      findMany: vi.fn((args: FindManyArgs) => {
        const found = rows.filter((row) => matches(row, args.where));
        if (args.orderBy?.createdAt === 'desc') {
          found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return Promise.resolve(args.take === undefined ? found : found.slice(0, args.take));
      }),
    },
  };

  return { stub, rows, prisma: stub as unknown as PrismaClient };
}

function serviceWith(seed: readonly Row[] = []) {
  const fake = fakePrisma(seed);
  return { ...fake, service: new DislikesService(fake.prisma) };
}

function row(overrides: Partial<Row> = {}): Row {
  const author = overrides.author ?? 'The Weeknd';
  const title = overrides.title ?? 'Blinding Lights';
  return {
    id: 'row-seed',
    userId: userIdOf('u1'),
    trackKey: identityOf(author, title).key,
    isrc: null,
    author,
    title,
    source: 'command',
    createdAt: new Date(0),
    ...overrides,
  };
}

describe('DislikesService.add', () => {
  it('stores the canonical track key, not a provider id', async () => {
    const { service, rows, stub } = serviceWith();

    await expect(
      service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'button'),
    ).resolves.toBe(true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.trackKey).toBe(identityOf('The Weeknd', 'Blinding Lights').key);
    expect(rows[0]?.source).toBe('button');
    // A bot-only user still gets a row, so the dislike survives to the dashboard.
    expect(stub.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { discordId: 'u1', username: 'Ada' } }),
    );
  });

  // The headline claim: the dislike follows the recording, not the upload.
  it('treats a decorated provider title as the same song', async () => {
    const { service } = serviceWith();

    await service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'command');
    const second = await service.add(
      'u1',
      'Ada',
      { title: 'The Weeknd - Blinding Lights (Official Video)', author: 'The Weeknd' },
      'button',
    );

    expect(second).toBe(false);
  });

  it('is idempotent for the very same track', async () => {
    const { service, rows } = serviceWith();
    const track = { title: 'Blinding Lights', author: 'The Weeknd' };

    expect(await service.add('u1', 'Ada', track, 'command')).toBe(true);
    expect(await service.add('u1', 'Ada', track, 'command')).toBe(false);
    expect(rows).toHaveLength(1);
  });

  // Two surfaces can rush the same track; the loser reports "already", never
  // throws into an interaction handler.
  it('reports a lost unique-constraint race as already disliked', async () => {
    const { service, stub } = serviceWith();
    stub.dislikedTrack.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'command'),
    ).resolves.toBe(false);
  });

  it('rethrows a failure that is not a unique violation', async () => {
    const { service, stub } = serviceWith();
    stub.dislikedTrack.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'command'),
    ).rejects.toThrow('connection lost');
  });

  it('normalises a well-formed ISRC and drops a malformed one', async () => {
    const { service, rows } = serviceWith();

    await service.add(
      'u1',
      'Ada',
      { title: 'Blinding Lights', author: 'The Weeknd', isrc: 'usug1-190-1216' },
      'command',
    );
    await service.add(
      'u1',
      'Ada',
      { title: 'Save Your Tears', author: 'The Weeknd', isrc: 'not-an-isrc' },
      'command',
    );

    expect(rows[0]?.isrc).toBe('USUG11901216');
    expect(rows[1]?.isrc).toBeNull();
  });

  it('stores a null ISRC when the caller has none', async () => {
    const { service, rows } = serviceWith();

    await service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'dashboard');

    expect(rows[0]?.isrc).toBeNull();
  });

  it('refuses to grow past the per-user cap', async () => {
    const { service, stub } = serviceWith();
    stub.dislikedTrack.count.mockResolvedValueOnce(DISLIKES_MAX_PER_USER);

    await expect(
      service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'command'),
    ).rejects.toThrow(String(DISLIKES_MAX_PER_USER));
    expect(stub.dislikedTrack.create).not.toHaveBeenCalled();
  });

  it('counts only the disliking user against the cap', async () => {
    const { service, stub } = serviceWith();

    await service.add('u1', 'Ada', { title: 'Blinding Lights', author: 'The Weeknd' }, 'command');

    expect(stub.dislikedTrack.count).toHaveBeenCalledWith({ where: { userId: userIdOf('u1') } });
  });
});

describe('DislikesService.remove', () => {
  it('removes only that user’s row and reports it', async () => {
    const key = identityOf('The Weeknd', 'Blinding Lights').key;
    const { service, rows } = serviceWith([row(), row({ id: 'other', userId: userIdOf('u2') })]);

    await expect(service.remove('u1', key)).resolves.toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userIdOf('u2'));
  });

  it('reports false when the track was not disliked', async () => {
    const { service } = serviceWith([row()]);

    await expect(service.remove('u1', 'nobody::nothing')).resolves.toBe(false);
  });
});

describe('DislikesService.list', () => {
  it('returns that user’s dislikes newest first', async () => {
    const { service } = serviceWith([
      row({ id: 'a', title: 'Older', createdAt: new Date(1) }),
      row({ id: 'b', title: 'Newer', createdAt: new Date(2) }),
      row({ id: 'c', title: 'Theirs', userId: userIdOf('u2'), createdAt: new Date(3) }),
    ]);

    const listed = await service.list('u1');

    expect(listed.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
  });

  it('honours the limit', async () => {
    const { service, stub } = serviceWith([
      row({ id: 'a', title: 'One', createdAt: new Date(1) }),
      row({ id: 'b', title: 'Two', createdAt: new Date(2) }),
    ]);

    expect(await service.list('u1', 1)).toHaveLength(1);
    expect(stub.dislikedTrack.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });
});

describe('DislikesService.keysFor', () => {
  // One rejection in the room is enough: the union is deliberate.
  it('unions the keys of every listener', async () => {
    const { service } = serviceWith([
      row({ id: 'a' }),
      row({ id: 'b', userId: userIdOf('u2'), title: 'Save Your Tears' }),
      row({ id: 'c', userId: userIdOf('u3'), title: 'Nobody Asked' }),
    ]);

    const keys = await service.keysFor(['u1', 'u2']);

    expect(keys.has(identityOf('The Weeknd', 'Blinding Lights').key)).toBe(true);
    expect(keys.has(identityOf('The Weeknd', 'Save Your Tears').key)).toBe(true);
    expect(keys.has(identityOf('The Weeknd', 'Nobody Asked').key)).toBe(false);
    expect(keys.size).toBe(2);
  });

  // An empty channel must not turn into "where discordId in []", which some
  // planners would read as "everyone".
  it('returns an empty set without querying for no listeners', async () => {
    const { service, stub } = serviceWith([row()]);

    expect((await service.keysFor([])).size).toBe(0);
    expect(stub.dislikedTrack.findMany).not.toHaveBeenCalled();
  });

  it('bounds the read', async () => {
    const { service, stub } = serviceWith();

    await service.keysFor(['u1']);

    expect(stub.dislikedTrack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2000 }),
    );
  });
});

describe('DislikesService.artistCountsFor', () => {
  it('counts rejections per canonical artist', async () => {
    const { service } = serviceWith([
      row({ id: 'a', title: 'Blinding Lights' }),
      row({ id: 'b', title: 'Save Your Tears (Official Video)' }),
      row({ id: 'c', userId: userIdOf('u2'), author: 'Drake', title: 'Hotline Bling' }),
    ]);

    const counts = await service.artistCountsFor(['u1', 'u2']);

    expect(counts.get(identityOf('The Weeknd', 'x').artistKey)).toBe(2);
    expect(counts.get(identityOf('Drake', 'x').artistKey)).toBe(1);
  });

  it('returns an empty map without querying for no listeners', async () => {
    const { service, stub } = serviceWith([row()]);

    expect((await service.artistCountsFor([])).size).toBe(0);
    expect(stub.dislikedTrack.findMany).not.toHaveBeenCalled();
  });
});

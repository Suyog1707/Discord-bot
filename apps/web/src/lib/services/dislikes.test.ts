import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodePlayerCommand,
  PLAYER_COMMAND_CHANNEL,
  ValidationError,
} from '@discord-music/shared';

const db = { marker: 'db' };
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

vi.mock('@discord-music/database', () => domain);

const { addDislike, removeDislike, listDislikes: listDislikeRows } = domain;

const { addDislikeForUser, listDislikes, removeDislikeForUser } = await import('./dislikes');

const USER = { discordId: '123456789012345678', username: 'listener' };
const GUILD_ID = '987654321098765432';

/** The single command this test published, decoded through the shared schema. */
function publishedCommand() {
  expect(publish).toHaveBeenCalledTimes(1);
  const [channel, payload] = publish.mock.calls[0] as [string, string];
  expect(channel).toBe(PLAYER_COMMAND_CHANNEL);
  return decodePlayerCommand(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
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

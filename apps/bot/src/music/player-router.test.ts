/**
 * Routing a guild's several rooms to the bots serving them.
 *
 * The allocation *rules* are tested in `bot-allocation.test.ts`; this covers
 * the wiring around them — that a lookup finds the right bot, that a claim is
 * taken before anything awaits, and that tearing one room down leaves the
 * others playing.
 */
import { describe, expect, it, vi } from 'vitest';

import { PlayerRouter, roomIdOf, type RouterBot } from './player-router.js';

const GUILD = 'guild-1';

interface FakePlayer {
  voiceChannelId: string;
  hasListeners: boolean;
  stayConnected: boolean;
  emptySince: number | null;
}

/** A manager holding at most one player, which is all a token can ever hold. */
function fakeBot(
  botId: string,
  options: {
    player?: Partial<FakePlayer> & { voiceChannelId: string };
    inGuild?: boolean;
    /** Held open to keep a join in flight while another request arrives. */
    joinGate?: Promise<void>;
  } = {},
): RouterBot & { destroyed: ReturnType<typeof vi.fn> } {
  let player: FakePlayer | undefined =
    options.player === undefined
      ? undefined
      : { hasListeners: true, stayConnected: false, emptySince: null, ...options.player };

  const destroyed = vi.fn(() => {
    player = undefined;
    return Promise.resolve();
  });

  return {
    botId,
    destroyed,
    isInGuild: () => options.inGuild ?? true,
    music: {
      getPlayer: () => player,
      destroyPlayer: destroyed,
      getOrCreatePlayer: async (join: { voiceChannelId: string }) => {
        await options.joinGate;
        player = {
          voiceChannelId: join.voiceChannelId,
          hasListeners: true,
          stayConnected: false,
          emptySince: null,
        };
        return player;
      },
    } as never,
  };
}

const join = (voiceChannelId: string) => ({
  guildId: GUILD,
  voiceChannelId,
  textChannelId: 'text',
  shardId: 0,
});

describe('roomIdOf', () => {
  it('pairs the guild with the channel', () => {
    expect(roomIdOf('g', 'c')).toBe('g:c');
  });
});

describe('playerFor', () => {
  it('finds the bot serving a room', () => {
    const router = new PlayerRouter([
      fakeBot('a', { player: { voiceChannelId: 'room-a' } }),
      fakeBot('b', { player: { voiceChannelId: 'room-b' } }),
    ]);

    expect(router.playerFor(GUILD, 'room-b')?.voiceChannelId).toBe('room-b');
  });

  /** The isolation property: a room nobody is serving is simply not there. */
  it('returns nothing for a channel no bot is in', () => {
    const router = new PlayerRouter([fakeBot('a', { player: { voiceChannelId: 'room-a' } })]);

    expect(router.playerFor(GUILD, 'room-z')).toBeUndefined();
  });
});

describe('roomsIn', () => {
  it('lists every room the guild has playing, with its manager', () => {
    const router = new PlayerRouter([
      fakeBot('a', { player: { voiceChannelId: 'room-a' } }),
      fakeBot('b'),
      fakeBot('c', { player: { voiceChannelId: 'room-c' } }),
    ]);

    const rooms = router.roomsIn(GUILD);

    expect(rooms.map((room) => room.voiceChannelId)).toEqual(['room-a', 'room-c']);
    expect(rooms[0]?.music).toBeDefined();
  });
});

describe('joinRoom', () => {
  it('reuses the bot already in the room', async () => {
    const busy = fakeBot('a', { player: { voiceChannelId: 'room-a' } });
    const spare = fakeBot('b');
    const router = new PlayerRouter([busy, spare]);

    const player = await router.joinRoom(join('room-a'));

    expect(player.voiceChannelId).toBe('room-a');
    expect(spare.music.getPlayer(GUILD)).toBeUndefined();
  });

  it('gives a second channel a different bot', async () => {
    const first = fakeBot('a', { player: { voiceChannelId: 'room-a' } });
    const second = fakeBot('b');
    const router = new PlayerRouter([first, second]);

    await router.joinRoom(join('room-b'));

    expect(first.music.getPlayer(GUILD)?.voiceChannelId).toBe('room-a');
    expect(second.music.getPlayer(GUILD)?.voiceChannelId).toBe('room-b');
  });

  /**
   * The race the claim exists for: joining awaits a voice handshake, during
   * which the bot has no player and looks free to a second request.
   */
  it('does not hand the same bot to two rooms at once', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A join that blocks, so the two calls genuinely overlap.
    const only = fakeBot('a', { joinGate: gate });
    const router = new PlayerRouter([only]);

    const first = router.joinRoom(join('room-a'));
    const second = router.joinRoom(join('room-b'));
    release();

    await expect(first).resolves.toBeDefined();
    // The only bot was claimed for room-a, so room-b has nowhere to go.
    await expect(second).rejects.toThrow(/busy|available/iu);
  });

  it('refuses when every bot is busy and none can be invited', async () => {
    const router = new PlayerRouter([fakeBot('a', { player: { voiceChannelId: 'room-a' } })]);

    await expect(router.joinRoom(join('room-b'))).rejects.toThrow(/already busy/iu);
  });

  it('asks for another player when one is not in the guild yet', async () => {
    const router = new PlayerRouter([
      fakeBot('a', { player: { voiceChannelId: 'room-a' } }),
      fakeBot('b', { inGuild: false }),
    ]);

    await expect(router.joinRoom(join('room-b'))).rejects.toThrow(/Add another player/iu);
  });
});

describe('leaveRoom', () => {
  /** Tearing one room down must not touch the others. */
  it('destroys only the room asked for', async () => {
    const a = fakeBot('a', { player: { voiceChannelId: 'room-a' } });
    const b = fakeBot('b', { player: { voiceChannelId: 'room-b' } });
    const router = new PlayerRouter([a, b]);

    await router.leaveRoom(GUILD, 'room-b');

    expect(a.destroyed).not.toHaveBeenCalled();
    expect(b.destroyed).toHaveBeenCalled();
    expect(a.music.getPlayer(GUILD)?.voiceChannelId).toBe('room-a');
  });

  it('is a no-op for a channel nothing is playing in', async () => {
    const a = fakeBot('a', { player: { voiceChannelId: 'room-a' } });
    await new PlayerRouter([a]).leaveRoom(GUILD, 'room-z');

    expect(a.destroyed).not.toHaveBeenCalled();
  });
});

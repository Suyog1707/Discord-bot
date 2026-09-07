/**
 * Two channels of one server must not share an autoplay session.
 *
 * The ledger is what decides anti-repeat, exclusions and reservations. When it
 * was keyed by server, two rooms spent each other's cooldowns and could be
 * handed the same song at the same moment. These tests pin the isolation, and
 * the one thing that must still be shared: a reservation is per room, so two
 * rooms picking the same song independently is allowed.
 */
import { describe, expect, it } from 'vitest';

import { roomIdOf, roomRefOf } from './room.js';
import { AutoplaySessionStore, type SessionEntry } from './session.js';

const GUILD = 'guild-1';
const ROOM_A = roomRefOf(GUILD, 'vc-a');
const ROOM_B = roomRefOf(GUILD, 'vc-b');

function entry(artist: string, title: string): SessionEntry {
  return {
    key: `${artist}::${title}`,
    identifier: `${artist}-${title}`,
    artistKey: artist.toLowerCase(),
    origin: 'user',
  };
}

describe('roomIdOf', () => {
  it('pairs the server with the channel', () => {
    expect(roomIdOf('g', 'c')).toBe('g:c');
  });

  it('gives two channels of one server different ids', () => {
    expect(ROOM_A.roomId).not.toBe(ROOM_B.roomId);
    expect(ROOM_A.guildId).toBe(ROOM_B.guildId);
  });
});

describe('two rooms in one server', () => {
  it('keep separate recently-played ledgers', async () => {
    const session = new AutoplaySessionStore();

    await session.recordPlayed(ROOM_A.roomId, entry('Artist', 'Only In A'));

    const a = await session.snapshot(ROOM_A.roomId);
    const b = await session.snapshot(ROOM_B.roomId);

    expect(a.recentKeys).toContain('Artist::Only In A');
    expect(b.recentKeys).not.toContain('Artist::Only In A');
  });

  it('keep separate queues, so one room never excludes the other', async () => {
    const session = new AutoplaySessionStore();

    await session.syncQueue(ROOM_A.roomId, [entry('Artist', 'Queued In A')]);

    expect((await session.snapshot(ROOM_A.roomId)).queuedKeys.size).toBe(1);
    expect((await session.snapshot(ROOM_B.roomId)).queuedKeys.size).toBe(0);
  });

  /**
   * Deliberately NOT shared. A server-wide reservation would starve the second
   * room of the best candidates, and two channels playing the same song at the
   * same time is ordinary.
   */
  it('can both reserve the same song', async () => {
    const session = new AutoplaySessionStore();

    const inA = await session.reserve(ROOM_A.roomId, ['Artist::Shared']);
    const inB = await session.reserve(ROOM_B.roomId, ['Artist::Shared']);

    expect(inA.has('Artist::Shared')).toBe(true);
    expect(inB.has('Artist::Shared')).toBe(true);
  });

  /** Within one room, a reservation still does its job. */
  it('still stop one room double-picking a song', async () => {
    const session = new AutoplaySessionStore();

    const first = await session.reserve(ROOM_A.roomId, ['Artist::Once']);
    const second = await session.reserve(ROOM_A.roomId, ['Artist::Once']);

    expect(first.has('Artist::Once')).toBe(true);
    expect(second.has('Artist::Once')).toBe(false);
  });

  it('keep separate listeners', async () => {
    const session = new AutoplaySessionStore();

    await session.setListener(ROOM_A.roomId, '111111111111111111');
    await session.setListener(ROOM_B.roomId, '222222222222222222');

    expect((await session.snapshot(ROOM_A.roomId)).primaryListenerId).toBe('111111111111111111');
    expect((await session.snapshot(ROOM_B.roomId)).primaryListenerId).toBe('222222222222222222');
  });

  it('keep separate session dislikes', async () => {
    const session = new AutoplaySessionStore();

    await session.recordDisliked(ROOM_A.roomId, ['Artist::Hated']);

    expect((await session.snapshot(ROOM_A.roomId)).dislikedKeys.has('Artist::Hated')).toBe(true);
    expect((await session.snapshot(ROOM_B.roomId)).dislikedKeys.has('Artist::Hated')).toBe(false);
  });

  /** Ending one room's session must not wipe the other's. */
  it('survive the other room being cleared', async () => {
    const session = new AutoplaySessionStore();
    await session.recordPlayed(ROOM_A.roomId, entry('Artist', 'In A'));
    await session.recordPlayed(ROOM_B.roomId, entry('Artist', 'In B'));

    await session.clear(ROOM_A.roomId);

    expect((await session.snapshot(ROOM_A.roomId)).recentKeys).toHaveLength(0);
    expect((await session.snapshot(ROOM_B.roomId)).recentKeys).toContain('Artist::In B');
  });
});

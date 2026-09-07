import { describe, expect, it } from 'vitest';

import { allocateBot, type FleetMember } from './bot-allocation.js';

const NOW = 1_000_000;
const GRACE_MS = 30_000;

function member(botId: string, overrides: Partial<FleetMember> = {}): FleetMember {
  return { botId, inGuild: true, serving: null, claimedFor: null, ...overrides };
}

/** A bot playing in `channelId` to a room with people in it. */
function busy(botId: string, channelId: string): FleetMember {
  return member(botId, {
    serving: {
      voiceChannelId: channelId,
      listenersPresent: true,
      stayConnected: false,
      emptySince: null,
    },
  });
}

/** A bot in a channel everyone has left, `emptyForMs` ago. */
function idle(
  botId: string,
  channelId: string,
  emptyForMs: number,
  stayConnected = false,
): FleetMember {
  return member(botId, {
    serving: {
      voiceChannelId: channelId,
      listenersPresent: false,
      stayConnected,
      emptySince: NOW - emptyForMs,
    },
  });
}

function allocate(fleet: readonly FleetMember[], hasUninvitedPlayers = false) {
  return allocateBot({
    voiceChannelId: 'target',
    fleet,
    now: NOW,
    reclaimGraceMs: GRACE_MS,
    hasUninvitedPlayers,
  });
}

describe('allocateBot', () => {
  it('reuses the bot already serving the room', () => {
    const fleet = [member('a'), busy('b', 'target')];

    expect(allocate(fleet)).toEqual({ kind: 'existing', botId: 'b' });
  });

  /** The race guard: a bot mid-join has no player yet but is not free. */
  it('reuses a bot already promised the room', () => {
    const fleet = [member('a', { claimedFor: 'target' }), member('b')];

    expect(allocate(fleet)).toEqual({ kind: 'existing', botId: 'a' });
  });

  it('never hands out a bot promised to a different room', () => {
    const fleet = [member('a', { claimedFor: 'elsewhere' }), member('b')];

    expect(allocate(fleet)).toEqual({ kind: 'free', botId: 'b' });
  });

  it('gives out an idle bot', () => {
    expect(allocate([busy('a', 'other'), member('b')])).toEqual({ kind: 'free', botId: 'b' });
  });

  /** Taking a bot off a room, even an empty one, is worse than using a spare. */
  it('prefers a free bot over reclaiming one', () => {
    const fleet = [idle('a', 'empty', 10 * GRACE_MS), member('b')];

    expect(allocate(fleet)).toEqual({ kind: 'free', botId: 'b' });
  });

  it('reclaims a bot whose room has been empty long enough', () => {
    const fleet = [busy('a', 'other'), idle('b', 'abandoned', GRACE_MS + 1)];

    expect(allocate(fleet)).toEqual({ kind: 'reclaim', botId: 'b', from: 'abandoned' });
  });

  /** A channel is briefly empty in the middle of a mass move. */
  it('leaves a room that only just emptied alone', () => {
    const fleet = [busy('a', 'other'), idle('b', 'justleft', GRACE_MS - 1)];

    expect(allocate(fleet)).toEqual({ kind: 'full' });
  });

  /** The rule the user asked for: 24/7 rooms are empty on purpose. */
  it('never reclaims a 24/7 room', () => {
    const fleet = [busy('a', 'other'), idle('b', 'always-on', 10 * GRACE_MS, true)];

    expect(allocate(fleet)).toEqual({ kind: 'full' });
  });

  it('reclaims the room that has been empty longest', () => {
    const fleet = [idle('a', 'recent', GRACE_MS + 1), idle('b', 'stale', 10 * GRACE_MS)];

    expect(allocate(fleet)).toEqual({ kind: 'reclaim', botId: 'b', from: 'stale' });
  });

  /** A bot that is not in the server cannot serve it, however idle it looks. */
  it('ignores bots that are not in the guild', () => {
    const fleet = [member('a', { inGuild: false }), busy('b', 'other')];

    expect(allocate(fleet, true)).toEqual({ kind: 'invite' });
  });

  it('asks for another player when one could still be invited', () => {
    expect(allocate([busy('a', 'other')], true)).toEqual({ kind: 'invite' });
  });

  it('reports full when there is nobody left to invite', () => {
    expect(allocate([busy('a', 'other')], false)).toEqual({ kind: 'full' });
  });

  it('asks for a player when the server has invited none at all', () => {
    expect(allocate([], true)).toEqual({ kind: 'invite' });
  });

  it('is deterministic — the same fleet always yields the same bot', () => {
    const fleet = [busy('a', 'other'), member('b'), member('c')];

    expect(allocate(fleet)).toEqual(allocate(fleet));
    expect(allocate(fleet)).toEqual({ kind: 'free', botId: 'b' });
  });
});

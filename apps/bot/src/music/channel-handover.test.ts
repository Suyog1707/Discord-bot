import { describe, expect, it } from 'vitest';

import { decideHandover } from './channel-handover.js';

describe('decideHandover', () => {
  it('stays put when the bot is already in the requested channel', () => {
    expect(
      decideHandover({ currentChannelId: 'vc-1', targetChannelId: 'vc-1', listenersInCurrent: 4 }),
    ).toEqual({ kind: 'stay' });
  });

  it('moves when nobody is left in the channel the bot occupies', () => {
    expect(
      decideHandover({ currentChannelId: 'vc-1', targetChannelId: 'vc-2', listenersInCurrent: 0 }),
    ).toEqual({ kind: 'move' });
  });

  it('refuses to abandon a room that still has listeners', () => {
    expect(
      decideHandover({ currentChannelId: 'vc-1', targetChannelId: 'vc-2', listenersInCurrent: 3 }),
    ).toEqual({ kind: 'busy', listeners: 3 });
  });

  it('treats one remaining listener as enough to hold the bot', () => {
    expect(
      decideHandover({ currentChannelId: 'vc-1', targetChannelId: 'vc-2', listenersInCurrent: 1 }),
    ).toEqual({ kind: 'busy', listeners: 1 });
  });
});

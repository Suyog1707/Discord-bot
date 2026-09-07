import { encodePlayerEvent, type PlayerEvent } from '@discord-music/shared';
import { describe, expect, it } from 'vitest';

import { initialPlayerEvent } from './sse';

const ROOM = 'vc-1';

function eventFor(guildId: string, voiceChannelId = ROOM): PlayerEvent {
  return {
    type: 'TRACK_START',
    guildId,
    voiceChannelId,
    sentAt: 1_700_000_000_000,
    state: {
      current: {
        identifier: 'abc',
        title: 'Kesariya',
        author: 'Arijit Singh',
        durationMs: 261_000,
        uri: null,
        artworkUrl: null,
        isStream: false,
        source: 'youtube',
        requestedByName: 'suyog',
        trackKey: 'arijit singh::kesariya',
      },
      positionMs: 1000,
      paused: false,
      volume: 100,
      loopMode: 'off',
      autoplayEnabled: false,
      stayConnected: false,
      activeFilter: null,
      voiceChannelId,
      listenerId: null,
      upcoming: [],
      upcomingTotal: 0,
    },
  };
}

describe('initialPlayerEvent', () => {
  it('returns the retained snapshot for the requested room', () => {
    const event = eventFor('123');

    expect(initialPlayerEvent(encodePlayerEvent(event), '123', ROOM)).toEqual(event);
  });

  it('refuses a snapshot belonging to another guild', () => {
    expect(initialPlayerEvent(encodePlayerEvent(eventFor('456')), '123', ROOM)).toBeNull();
  });

  /**
   * The isolation check: two channels of one server are different streams, and
   * one room's retained state must never open another room's player.
   */
  it('refuses a snapshot from another room of the same guild', () => {
    const otherRoom = encodePlayerEvent(eventFor('123', 'vc-2'));

    expect(initialPlayerEvent(otherRoom, '123', ROOM)).toBeNull();
  });

  it('ignores a malformed retained value', () => {
    expect(initialPlayerEvent('{ not json', '123', ROOM)).toBeNull();
    expect(initialPlayerEvent('{"type":"TRACK_START"}', '123', ROOM)).toBeNull();
  });

  it('sends nothing when no state is retained', () => {
    expect(initialPlayerEvent(null, '123', ROOM)).toBeNull();
  });
});

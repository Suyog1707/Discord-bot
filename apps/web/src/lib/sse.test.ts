import { encodePlayerEvent, type PlayerEvent } from '@discord-music/shared';
import { describe, expect, it } from 'vitest';

import { initialPlayerEvent } from './sse';

function eventFor(guildId: string): PlayerEvent {
  return {
    type: 'TRACK_START',
    guildId,
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
      voiceChannelId: '999',
      listenerId: null,
      upcoming: [],
      upcomingTotal: 0,
    },
  };
}

describe('initialPlayerEvent', () => {
  it('returns the retained snapshot for the requested guild', () => {
    const event = eventFor('123');

    expect(initialPlayerEvent(encodePlayerEvent(event), '123')).toEqual(event);
  });

  it('refuses a snapshot belonging to another guild', () => {
    expect(initialPlayerEvent(encodePlayerEvent(eventFor('456')), '123')).toBeNull();
  });

  it('ignores a malformed retained value', () => {
    expect(initialPlayerEvent('{ not json', '123')).toBeNull();
    expect(initialPlayerEvent('{"type":"TRACK_START"}', '123')).toBeNull();
  });

  it('sends nothing when no state is retained', () => {
    expect(initialPlayerEvent(null, '123')).toBeNull();
  });
});

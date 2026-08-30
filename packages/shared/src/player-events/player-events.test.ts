import { describe, expect, it } from 'vitest';

import {
  decodePlayerEvent,
  encodePlayerEvent,
  PLAYER_STATE_TTL_SECONDS,
  playerStateKey,
  type PlayerEvent,
} from './index.js';

describe('playerStateKey', () => {
  it('namespaces the retained snapshot per guild', () => {
    expect(playerStateKey('123')).toBe('dmp:player:state:123');
    expect(playerStateKey('456')).not.toBe(playerStateKey('123'));
  });

  it('retains state long enough to outlive a listening session', () => {
    expect(PLAYER_STATE_TTL_SECONDS).toBe(6 * 60 * 60);
  });
});

describe('encode/decode round trip', () => {
  it('preserves the newer optional fields (trackKey, listenerId)', () => {
    const event: PlayerEvent = {
      type: 'TRACK_START',
      guildId: '123',
      sentAt: 1_700_000_000_000,
      state: {
        current: {
          identifier: 'abc',
          title: 'Kesariya',
          author: 'Arijit Singh',
          durationMs: 261_000,
          uri: 'https://example.invalid/abc',
          artworkUrl: null,
          isStream: false,
          source: 'youtube',
          requestedByName: 'suyog',
          trackKey: 'arijit singh::kesariya',
        },
        positionMs: 4200,
        paused: false,
        volume: 80,
        loopMode: 'off',
        autoplayEnabled: true,
        stayConnected: false,
        activeFilter: null,
        voiceChannelId: '999',
        listenerId: '777',
        upcoming: [],
        upcomingTotal: 0,
      },
    };

    const decoded = decodePlayerEvent(encodePlayerEvent(event));

    expect(decoded).toEqual(event);
    expect(decoded?.state?.current?.trackKey).toBe('arijit singh::kesariya');
    expect(decoded?.state?.listenerId).toBe('777');
  });

  it('rejects malformed payloads', () => {
    expect(decodePlayerEvent('not json')).toBeNull();
    expect(decodePlayerEvent('{"type":"NOPE","guildId":"1","sentAt":0,"state":null}')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { decodeJoinRequest } from './join-request.js';

const valid = {
  guildId: '111111111111111111',
  voiceChannelId: '222222222222222222',
  textChannelId: '333333333333333333',
  shardId: 0,
};

describe('decodeJoinRequest', () => {
  it('accepts a well-formed request', () => {
    expect(decodeJoinRequest(valid)).toEqual(valid);
  });

  it('rejects a request with no channel to join', () => {
    // A bot joining channel `undefined` is a 500 nobody can explain; a 400 is
    // one somebody can.
    const { voiceChannelId, ...missing } = valid;
    void voiceChannelId;
    expect(decodeJoinRequest(missing)).toBeNull();
  });

  it('rejects a negative shard', () => {
    expect(decodeJoinRequest({ ...valid, shardId: -1 })).toBeNull();
  });

  it('carries the optional hints when they are given', () => {
    expect(decodeJoinRequest({ ...valid, listenerId: '444444444444444444' })).toEqual({
      ...valid,
      listenerId: '444444444444444444',
    });
    expect(decodeJoinRequest({ ...valid, resumeSavedQueue: false })).toEqual({
      ...valid,
      resumeSavedQueue: false,
    });
  });

  it('leaves absent hints absent rather than present-and-undefined', () => {
    // `JoinOptions` distinguishes the two: `listenerId: undefined` would mean
    // "no listener", not "the caller did not say".
    expect(Object.keys(decodeJoinRequest(valid) ?? {})).not.toContain('listenerId');
  });
});

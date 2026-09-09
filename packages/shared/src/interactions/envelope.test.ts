import { describe, expect, it } from 'vitest';

import {
  decodeInteractionEnvelope,
  encodeInteractionEnvelope,
  interactionAckKey,
  interactionQueueKey,
  rawSubcommandName,
  type InteractionEnvelope,
} from './envelope.js';

const payload = {
  id: '111111111111111111',
  application_id: '222222222222222222',
  token: 'interaction-token',
  type: 2,
  guild_id: '333333333333333333',
  channel_id: '444444444444444444',
  data: { name: 'play', options: [{ name: 'query', type: 3, value: 'lofi' }] },
};

const envelope: InteractionEnvelope = {
  payload,
  deferral: 'public',
  voiceChannelId: '555555555555555555',
  routedAt: 1_700_000_000_000,
};

describe('keys', () => {
  it('gives each bot its own queue', () => {
    expect(interactionQueueKey('player-2')).toBe('dmp:player:interactions:player-2');
  });

  it('names an ack by the interaction it belongs to', () => {
    expect(interactionAckKey('111')).toBe('dmp:player:ack:111');
  });
});

describe('the envelope codec', () => {
  it('round trips', () => {
    expect(decodeInteractionEnvelope(encodeInteractionEnvelope(envelope))).toEqual(envelope);
  });

  /**
   * The test that stops someone "tidying" the payload schema into a strict
   * object. discord.js reconstructs a real interaction from these bytes and
   * reads fields nothing here has an opinion about — dropping `entitlements`
   * makes the reconstruction throw on a field Discord did send.
   */
  it('carries fields it has no opinion about, untouched', () => {
    const rich = {
      ...envelope,
      payload: {
        ...payload,
        entitlements: [],
        app_permissions: '8',
        locale: 'en-GB',
        authorizing_integration_owners: { '0': '333333333333333333' },
        member: { user: { id: '666666666666666666' }, permissions: '8', roles: [] },
      },
    };

    const decoded = decodeInteractionEnvelope(encodeInteractionEnvelope(rich));

    expect(decoded?.payload).toEqual(rich.payload);
  });

  it('rejects a payload with no token to answer on', () => {
    const { token, ...rest } = payload;
    void token;
    expect(decodeInteractionEnvelope(JSON.stringify({ ...envelope, payload: rest }))).toBeNull();
  });

  it('rejects an envelope with no deferral', () => {
    const { deferral, ...rest } = envelope;
    void deferral;
    expect(decodeInteractionEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it('rejects malformed JSON rather than throwing', () => {
    expect(decodeInteractionEnvelope('{not json')).toBeNull();
  });
});

describe('rawSubcommandName', () => {
  it('finds a subcommand', () => {
    expect(rawSubcommandName({ name: 'favorite', options: [{ name: 'play', type: 1 }] })).toBe(
      'play',
    );
  });

  it('unwraps a subcommand group', () => {
    expect(
      rawSubcommandName({
        name: 'playlist',
        options: [{ name: 'manage', type: 2, options: [{ name: 'rename', type: 1 }] }],
      }),
    ).toBe('rename');
  });

  it('is null for a command whose options are plain values', () => {
    expect(rawSubcommandName(payload.data)).toBeNull();
  });

  it('is null for a command with no options at all', () => {
    expect(rawSubcommandName({ name: 'ping' })).toBeNull();
    expect(rawSubcommandName(null)).toBeNull();
  });
});

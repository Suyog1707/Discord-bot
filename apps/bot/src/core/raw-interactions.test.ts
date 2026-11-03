/**
 * The primary's memory of what Discord actually sent.
 *
 * The gateway router hands a command to another bot as the raw API payload,
 * exactly as the HTTP router does, because that is what the subscriber
 * rehydrates. discord.js does not keep the payload once it has built the
 * interaction, so the primary captures it off the `raw` event a moment
 * earlier. What matters here is that it is captured only for the kinds the
 * router forwards, read once, and cannot pile up.
 */
import { describe, expect, it } from 'vitest';

import { RAW_INTERACTION_TTL_MS, RawInteractionCache } from './raw-interactions.js';

function packet(id: string, type = 2, t = 'INTERACTION_CREATE') {
  return {
    op: 0,
    t,
    s: 1,
    d: { id, application_id: '000000000000000001', token: `tok-${id}`, type, guild_id: '1' },
  };
}

describe('RawInteractionCache', () => {
  it('keeps a command payload and hands it back once', () => {
    const cache = new RawInteractionCache();
    cache.capture(packet('a'));

    expect(cache.take('a')).toMatchObject({ id: 'a', token: 'tok-a', type: 2 });
    expect(cache.take('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('keeps components too, which the router hands to their owner', () => {
    const cache = new RawInteractionCache();
    cache.capture(packet('c', 3));
    expect(cache.take('c')).toMatchObject({ id: 'c', type: 3 });
  });

  it('ignores autocomplete and everything that is not an interaction', () => {
    const cache = new RawInteractionCache();
    cache.capture(packet('auto', 4));
    cache.capture(packet('msg', 2, 'MESSAGE_CREATE'));
    cache.capture(null);
    cache.capture({ t: 'INTERACTION_CREATE', d: null });
    cache.capture({ t: 'INTERACTION_CREATE', d: { type: 2 } });

    expect(cache.size).toBe(0);
  });

  it('forgets a payload nobody read before its expiry', () => {
    let now = 1_000_000;
    const cache = new RawInteractionCache({ now: () => now });
    cache.capture(packet('old'));

    now += RAW_INTERACTION_TTL_MS + 1;
    expect(cache.take('old')).toBeUndefined();
  });

  it('prunes expired entries as new ones arrive, so the map cannot leak', () => {
    let now = 1_000_000;
    const cache = new RawInteractionCache({ now: () => now });
    for (let index = 0; index < 50; index += 1) cache.capture(packet(`x${String(index)}`));

    now += RAW_INTERACTION_TTL_MS + 1;
    cache.capture(packet('fresh'));

    expect(cache.size).toBe(1);
  });

  it('holds no more than its cap, dropping the oldest first', () => {
    const cache = new RawInteractionCache({ maxEntries: 3 });
    for (const id of ['1', '2', '3', '4']) cache.capture(packet(id));

    expect(cache.size).toBe(3);
    expect(cache.take('1')).toBeUndefined();
    expect(cache.take('4')).toBeDefined();
  });
});

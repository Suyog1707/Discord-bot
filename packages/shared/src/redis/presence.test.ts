import { describe, expect, it } from 'vitest';

import type { BotPresence } from '../fleet/index.js';

import { assembleGuildFleet } from './presence.js';

const GUILD_ENTRY = (botId: string, role: BotPresence['role'] = 'player'): string =>
  JSON.stringify({ botId, clientId: `app-${botId}`, role, rooms: [], sentAt: 1 });

describe('assembleGuildFleet', () => {
  it('reads who is in the server straight from the bots’ own lists', () => {
    const read = assembleGuildFleet({
      ids: ['main', 'player-2', 'player-5'],
      payloads: [GUILD_ENTRY('main', 'primary'), GUILD_ENTRY('player-2'), GUILD_ENTRY('player-5')],
      membership: [
        [1, 1],
        [1, 1],
        // Running, but not in this server: player-5 was never invited here.
        [1, 0],
      ],
      owner: '{"botId":"player-2"}',
    });

    expect(read.presence.map((entry) => entry.botId)).toEqual(['main', 'player-2', 'player-5']);
    expect(read.inGuild).toEqual(new Set(['main', 'player-2']));
    expect(read.owner).toBe('{"botId":"player-2"}');
    expect(read.gone).toEqual([]);
  });

  it('knows a bot in no servers apart from a bot that never wrote its list', () => {
    // The sentinel is what makes "in nothing" an answer rather than a gap.
    const read = assembleGuildFleet({
      ids: ['player-6'],
      payloads: [GUILD_ENTRY('player-6')],
      membership: [[1, 0]],
      owner: null,
    });

    expect(read.inGuild).toEqual(new Set());
  });

  it('gives up on the fast answer when any live bot has not published its list', () => {
    // A container from before the lists existed, mid-deploy. Reading its
    // silence as "not in this server" would route around a bot that is there.
    const read = assembleGuildFleet({
      ids: ['main', 'player-2'],
      payloads: [GUILD_ENTRY('main', 'primary'), GUILD_ENTRY('player-2')],
      membership: [
        [1, 1],
        [0, 0],
      ],
      owner: null,
    });

    expect(read.inGuild).toBeUndefined();
    expect(read.presence).toHaveLength(2);
  });

  it('ignores a dead bot entirely, list and all', () => {
    const read = assembleGuildFleet({
      ids: ['main', 'player-3'],
      payloads: [GUILD_ENTRY('main', 'primary'), null],
      // player-3's list is missing too, and must not make the answer unknown.
      membership: [[1, 1], null],
      owner: null,
    });

    expect(read.presence.map((entry) => entry.botId)).toEqual(['main']);
    expect(read.inGuild).toEqual(new Set(['main']));
    expect(read.gone).toEqual(['player-3']);
  });

  it('treats an unreadable entry as gone rather than failing the read', () => {
    const read = assembleGuildFleet({
      ids: ['player-4'],
      payloads: ['{not json'],
      membership: [[1, 1]],
      owner: null,
    });

    expect(read.presence).toEqual([]);
    expect(read.gone).toEqual(['player-4']);
  });
});

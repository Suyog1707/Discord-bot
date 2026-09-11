import { describe, expect, it } from 'vitest';

import { compareRoster, rosterFromPresence, type BotPresence } from './index.js';

function presence(botId: string, role: BotPresence['role'] = 'player'): BotPresence {
  return { botId, clientId: `app-${botId}`, role, rooms: [] };
}

describe('rosterFromPresence', () => {
  it('hands out the primary first, then players in the order their names read', () => {
    // Presence arrives in whatever order Redis keeps a set in. The second
    // channel should get player-2 every time, not whoever happened to be read
    // first — and player-10 belongs after player-3, not after player-1.
    const roster = rosterFromPresence([
      presence('player-10'),
      presence('player-3'),
      presence('main', 'primary'),
      presence('player-2'),
    ]);

    expect(roster.map((entry) => entry.botId)).toEqual([
      'main',
      'player-2',
      'player-3',
      'player-10',
    ]);
  });

  it('keeps each application id with its own bot', () => {
    expect(rosterFromPresence([presence('player-3'), presence('player-2')])).toEqual([
      { botId: 'player-2', clientId: 'app-player-2' },
      { botId: 'player-3', clientId: 'app-player-3' },
    ]);
  });
});

describe('compareRoster', () => {
  it('puts the primary first whatever it is called', () => {
    const sorted = [
      { botId: 'player-2', role: 'player' },
      { botId: 'zeta', role: 'primary' },
    ].sort(compareRoster);

    expect(sorted.map((entry) => entry.botId)).toEqual(['zeta', 'player-2']);
  });

  it('orders by label alone when no roles are known', () => {
    const sorted = [{ botId: 'player-4' }, { botId: 'player-3' }].sort(compareRoster);

    expect(sorted.map((entry) => entry.botId)).toEqual(['player-3', 'player-4']);
  });
});

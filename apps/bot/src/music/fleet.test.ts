import { describe, expect, it } from 'vitest';

import { buildFleet, nextUninvited, type BotPresence, type RosterEntry } from './fleet.js';

const GUILD = 'guild-1';

const ROSTER: readonly RosterEntry[] = [
  { botId: 'main', clientId: 'app-main' },
  { botId: 'player-2', clientId: 'app-2' },
  { botId: 'player-3', clientId: 'app-3' },
];

function present(botId: string, rooms: BotPresence['rooms'] = []): BotPresence {
  return {
    botId,
    clientId: `app-${botId === 'main' ? 'main' : botId.slice(-1)}`,
    role: botId === 'main' ? 'primary' : 'player',
    baseUrl: `http://bot-${botId}:8080`,
    rooms,
  };
}

/** A room with people in it. */
function busy(voiceChannelId: string, guildId = GUILD): BotPresence['rooms'][number] {
  return {
    guildId,
    voiceChannelId,
    isPlaying: true,
    hasListeners: true,
    stayConnected: false,
    emptySince: null,
  };
}

describe('buildFleet', () => {
  it('leaves out players that are not running', () => {
    // A container that is down cannot take a room, and reporting it as idle
    // would strand the request in a channel nobody ever joins.
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main', 'app-2', 'app-3']),
      presence: [present('main'), present('player-3')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members.map((member) => member.botId)).toEqual(['main', 'player-3']);
  });

  it('keeps the roster order, so players are handed out consistently', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main', 'app-2', 'app-3']),
      // Presence arrives in whatever order Redis returns it.
      presence: [present('player-3'), present('player-2'), present('main')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members.map((member) => member.botId)).toEqual(['main', 'player-2', 'player-3']);
  });

  it('marks a player as in the guild by application id, not by label', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main']),
      presence: [present('main'), present('player-2')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members.map((member) => member.inGuild)).toEqual([true, false]);
  });

  it('reports the room a player holds in this guild', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main']),
      presence: [present('main', [busy('room-a')])],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members[0]?.serving).toEqual({
      voiceChannelId: 'room-a',
      listenersPresent: true,
      stayConnected: false,
      emptySince: null,
    });
  });

  it('ignores rooms a player holds in other servers', () => {
    // One token holds one connection PER GUILD, so a player busy elsewhere is
    // still free here — treating it as busy would idle six bots for nothing.
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main']),
      presence: [present('main', [busy('room-x', 'other-guild')])],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members[0]?.serving).toBeNull();
  });

  it('carries a claim through, so a room being joined is not offered twice', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main']),
      presence: [present('main')],
      claims: new Map([['main', 'room-a']]),
      guildId: GUILD,
    });

    expect(view.members[0]?.claimedFor).toBe('room-a');
  });

  it('gives an address for every live player', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(),
      presence: [present('player-2')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.addresses.get('player-2')).toBe('http://bot-player-2:8080');
    // Application ids come from the roster, so an invite can be offered for a
    // player that is not running.
    expect(view.clientIds.get('player-3')).toBe('app-3');
  });
});

describe('nextUninvited', () => {
  it('names the first player the guild has not added', () => {
    expect(nextUninvited(ROSTER, new Set(['app-main']))?.botId).toBe('player-2');
  });

  it('names nobody when the guild has them all', () => {
    expect(nextUninvited(ROSTER, new Set(['app-main', 'app-2', 'app-3']))).toBeUndefined();
  });

  it('offers a player that is not currently running', () => {
    // Read off the roster, not off presence: an invite for a container that
    // happens to be restarting is still a valid invite.
    expect(nextUninvited(ROSTER, new Set(['app-main', 'app-2']))?.botId).toBe('player-3');
  });
});

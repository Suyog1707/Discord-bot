import { describe, expect, it } from 'vitest';

import { buildFleet, type BotPresence, type RosterEntry } from './index.js';

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

describe('buildFleet staleness', () => {
  const NOW = 1_000_000;
  const STALE_AFTER_MS = 45_000;

  const withSentAt = (botId: string, sentAt: number): BotPresence => ({
    ...present(botId),
    sentAt,
  });

  const allocatable = (presence: readonly BotPresence[]) =>
    buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main', 'app-2', 'app-3']),
      presence,
      claims: new Map(),
      guildId: GUILD,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    }).members.map((member) => member.botId);

  it('drops a player whose entry has gone quiet', () => {
    // Its Redis key has not expired yet — the TTL is deliberately generous —
    // but handing it a channel it will never join leaves somebody watching a
    // spinner until the interaction dies.
    expect(
      allocatable([withSentAt('main', NOW - 1_000), withSentAt('player-2', NOW - 60_000)]),
    ).toEqual(['main']);
  });

  it('keeps one that answered within the window', () => {
    expect(allocatable([withSentAt('main', NOW - STALE_AFTER_MS)])).toEqual(['main']);
  });

  it('keeps an entry with no timestamp at all', () => {
    // Written by a container that predates the field. Dropping it would empty
    // the fleet halfway through a rolling deploy — a worse failure than the one
    // the check exists to prevent.
    expect(allocatable([present('main')])).toEqual(['main']);
  });

  it('accepts every entry when the caller did not ask about freshness', () => {
    // A reader that only wants the picture, rather than to hand out a room.
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main']),
      presence: [withSentAt('main', NOW - 10 * 60_000)],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.members.map((member) => member.botId)).toEqual(['main']);
  });
});

describe('uninvited', () => {
  const uninvitedFor = (invited: readonly string[]) =>
    buildFleet({
      roster: ROSTER,
      invited: new Set(invited),
      presence: [present('main')],
      claims: new Map(),
      guildId: GUILD,
    }).uninvited.map((entry) => entry.botId);

  it('lists the players this guild has not added, in roster order', () => {
    expect(uninvitedFor(['app-main'])).toEqual(['player-2', 'player-3']);
  });

  it('is empty when the guild has them all', () => {
    expect(uninvitedFor(['app-main', 'app-2', 'app-3'])).toEqual([]);
  });

  it('still lists a player that is not running', () => {
    // Read off the roster, not off presence: an invite for a container that
    // happens to be restarting is still a valid invite.
    expect(uninvitedFor(['app-main', 'app-2'])).toEqual(['player-3']);
  });
});

describe('primaryBotId', () => {
  it('names the primary from what it says about itself, not from its label', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-main', 'app-2']),
      presence: [present('main'), present('player-2')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.primaryBotId).toBe('main');
  });

  it('is undefined when the primary is not in this guild', () => {
    const view = buildFleet({
      roster: ROSTER,
      invited: new Set(['app-2']),
      presence: [present('main'), present('player-2')],
      claims: new Map(),
      guildId: GUILD,
    });

    expect(view.primaryBotId).toBeUndefined();
  });
});

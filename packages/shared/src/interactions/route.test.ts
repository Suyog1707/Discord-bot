import { describe, expect, it } from 'vitest';

import type { FleetMember, FleetView, RosterEntry } from '../fleet/index.js';

import { routeInteraction, type RouteInteractionInput } from './route.js';

const GUILD = '111111111111111111';
const ROOM_A = '222222222222222222';
const ROOM_B = '333333333333333333';
const NOW = 1_000_000;
const RECLAIM_GRACE_MS = 60_000;

const ROSTER: readonly RosterEntry[] = [
  { botId: 'main', clientId: 'app-main' },
  { botId: 'player-2', clientId: 'app-2' },
  { botId: 'player-3', clientId: 'app-3' },
];

function idle(botId: string): FleetMember {
  return { botId, inGuild: true, serving: null, claimedFor: null };
}

function busy(botId: string, voiceChannelId: string, overrides = {}): FleetMember {
  return {
    botId,
    inGuild: true,
    serving: {
      voiceChannelId,
      listenersPresent: true,
      stayConnected: false,
      emptySince: null,
      ...overrides,
    },
    claimedFor: null,
  };
}

function fleet(members: readonly FleetMember[], uninvited: readonly RosterEntry[] = []): FleetView {
  return {
    members,
    addresses: new Map(members.map((member) => [member.botId, `http://${member.botId}:8080`])),
    clientIds: new Map(ROSTER.map((entry) => [entry.botId, entry.clientId])),
    uninvited,
    primaryBotId: members.some((member) => member.botId === 'main') ? 'main' : undefined,
  };
}

function route(overrides: Partial<RouteInteractionInput> = {}) {
  return routeInteraction({
    guildId: GUILD,
    voiceChannelId: ROOM_A,
    ownerBotId: null,
    fleet: fleet([idle('main')]),
    now: NOW,
    reclaimGraceMs: RECLAIM_GRACE_MS,
    ...overrides,
  });
}

describe('routeInteraction', () => {
  describe('a room that already has a bot', () => {
    it('goes to whoever holds it', () => {
      // The overwhelmingly common case: every command mid-session.
      expect(
        route({
          ownerBotId: 'player-2',
          fleet: fleet([busy('main', ROOM_B), busy('player-2', ROOM_A)]),
        }),
      ).toEqual({
        kind: 'dispatch',
        botId: 'player-2',
        voiceChannelId: ROOM_A,
        reason: 'owner',
        claims: false,
      });
    });

    it('reserves nothing, because there is nothing to reserve', () => {
      const decision = route({ ownerBotId: 'main', fleet: fleet([busy('main', ROOM_A)]) });

      expect(decision).toMatchObject({ claims: false });
    });

    it('allocates afresh when the owner is no longer running', () => {
      // The owner claim expires on a timer, not on a crash, so a bot named
      // there but missing from the fleet is gone and the room is free.
      expect(route({ ownerBotId: 'player-2', fleet: fleet([idle('main')]) })).toMatchObject({
        botId: 'main',
        reason: 'free',
      });
    });
  });

  describe('a room nobody has', () => {
    it('gives it to an idle bot', () => {
      expect(route({ fleet: fleet([busy('main', ROOM_B), idle('player-2')]) })).toMatchObject({
        kind: 'dispatch',
        botId: 'player-2',
        reason: 'free',
        claims: true,
      });
    });

    it('is the second person in a second channel getting a second bot', () => {
      // The whole feature, in one assertion: main is playing in room A, so a
      // /play in room B must not be handed to main.
      const decision = route({
        voiceChannelId: ROOM_B,
        fleet: fleet([busy('main', ROOM_A), idle('player-2')]),
      });

      expect(decision).toMatchObject({ botId: 'player-2', voiceChannelId: ROOM_B });
    });

    it('reclaims a bot from a channel everyone left', () => {
      expect(
        route({
          voiceChannelId: ROOM_B,
          fleet: fleet([
            busy('main', ROOM_A, { listenersPresent: false, emptySince: NOW - 120_000 }),
          ]),
        }),
      ).toMatchObject({ botId: 'main', reason: 'reclaim', claims: true });
    });

    it('offers the next uninvited player when every bot here is busy', () => {
      const decision = route({
        voiceChannelId: ROOM_B,
        fleet: fleet([busy('main', ROOM_A)], [{ botId: 'player-2', clientId: 'app-2' }]),
      });

      expect(decision.kind).toBe('reply');
      expect(decision.kind === 'reply' && decision.message).toMatch(/player-2/u);
      expect(decision.kind === 'reply' && decision.message).toMatch(/oauth2\/authorize/u);
    });

    it('says everyone is busy when there is nobody left to add', () => {
      const decision = route({
        voiceChannelId: ROOM_B,
        fleet: fleet([busy('main', ROOM_A)]),
      });

      expect(decision.kind).toBe('reply');
      expect(decision.kind === 'reply' && decision.message).toMatch(/already busy/u);
    });
  });

  describe('a caller who is not in a voice channel', () => {
    /**
     * Deliberately no table of which commands need a room. The commands answer
     * that themselves, and a second copy of the answer would drift — so this
     * dispatches and lets `/play` produce the same refusal it always has.
     */
    it('goes to the primary', () => {
      expect(
        route({ voiceChannelId: null, fleet: fleet([idle('main'), idle('player-2')]) }),
      ).toEqual({
        kind: 'dispatch',
        botId: 'main',
        voiceChannelId: null,
        reason: 'fallback',
        claims: false,
      });
    });

    it('falls back to any bot in the guild when the primary is not here', () => {
      expect(route({ voiceChannelId: null, fleet: fleet([idle('player-2')]) })).toMatchObject({
        botId: 'player-2',
        reason: 'fallback',
      });
    });

    it('reserves nothing — a roomless command must not tie up a bot', () => {
      expect(route({ voiceChannelId: null })).toMatchObject({ claims: false });
    });

    it('says so when no bot is running at all', () => {
      const decision = route({ voiceChannelId: null, fleet: fleet([]) });

      expect(decision).toEqual({
        kind: 'reply',
        message: 'No player is available right now. Try again shortly.',
      });
    });
  });

  it('refuses outside a server', () => {
    expect(route({ guildId: null })).toEqual({
      kind: 'reply',
      message: 'This command can only be used in a server.',
    });
  });
});

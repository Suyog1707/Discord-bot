import { describe, expect, it } from 'vitest';

import { describeAllocation } from './describe-allocation.js';
import type { FleetView } from './index.js';

const GUILD = '111111111111111111';

function view(overrides: Partial<FleetView> = {}): FleetView {
  return {
    members: [],
    addresses: new Map(),
    clientIds: new Map([
      ['main', 'app-main'],
      ['player-2', 'app-2'],
    ]),
    uninvited: [{ botId: 'player-2', clientId: 'app-2' }],
    primaryBotId: 'main',
    ...overrides,
  };
}

/** A bot that is in this guild and holding a channel. */
function busy(botId: string, voiceChannelId: string) {
  return {
    botId,
    inGuild: true,
    serving: {
      voiceChannelId,
      listenersPresent: true,
      stayConnected: false,
      emptySince: null,
    },
    claimedFor: null,
  };
}

describe('describeAllocation', () => {
  it('offers the next uninvited player with a one-click link', () => {
    // The one moment the multi-bot design is visible to anybody: "all busy,
    // sorry" is a dead end, "all busy, here is the fix" is not.
    const message = describeAllocation(
      { kind: 'invite' },
      view({ members: [busy('main', '222222222222222222')] }),
      GUILD,
    );

    expect(message).toContain('player-2');
    expect(message).toMatch(/discord\.com\/oauth2\/authorize/u);
    expect(message).toContain('client_id=app-2');
    // A player registers no slash commands, so its invite must not ask for the
    // scope that would put a duplicate command set in the picker.
    expect(message).not.toContain('applications.commands');
  });

  it('does not offer a link when the view changed underneath the decision', () => {
    // `invite` said one existed; by the time we render, every bot is in. Say
    // the true thing rather than pointing at nobody.
    const everyone = view({
      members: [busy('main', '2'), busy('player-2', '3')],
      uninvited: [],
    });

    expect(describeAllocation({ kind: 'invite' }, everyone, GUILD)).toBe(
      'Every player is busy in another channel right now. Try again shortly.',
    );
  });

  it('names the channels that are busy, so the caller can join one', () => {
    const message = describeAllocation(
      { kind: 'full' },
      view({ members: [busy('main', '222'), busy('player-2', '333')] }),
      GUILD,
    );

    expect(message).toContain('<#222>');
    expect(message).toContain('<#333>');
  });

  it('falls back when the fleet is empty rather than naming no channels', () => {
    expect(describeAllocation({ kind: 'full' }, view(), GUILD)).toBe(
      'No player is available right now. Try again shortly.',
    );
  });
});

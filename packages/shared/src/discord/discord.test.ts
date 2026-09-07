import { describe, expect, it } from 'vitest';

import { BOT_INVITE_PERMISSIONS, botInviteUrl } from './index.js';

/** Parse the URL so assertions are about parameters, not string order. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('botInviteUrl', () => {
  it('points at the Discord OAuth authorize endpoint', () => {
    expect(botInviteUrl({ clientId: '123' })).toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize\?/u,
    );
  });

  it('carries the application id and the playback permissions', () => {
    const params = paramsOf(botInviteUrl({ clientId: '123' }));

    expect(params.get('client_id')).toBe('123');
    expect(params.get('permissions')).toBe(BOT_INVITE_PERMISSIONS);
  });

  it('pre-selects a server when one is given', () => {
    expect(paramsOf(botInviteUrl({ clientId: '123', guildId: '456' })).get('guild_id')).toBe('456');
  });

  it('omits the server when none is given', () => {
    expect(paramsOf(botInviteUrl({ clientId: '123' })).has('guild_id')).toBe(false);
  });

  it('asks for slash commands by default', () => {
    expect(paramsOf(botInviteUrl({ clientId: '123' })).get('scope')).toBe(
      'bot applications.commands',
    );
  });

  /**
   * A player registers no commands, so asking for them would put a permission
   * in the consent screen it will never use.
   */
  it('asks only for bot when the player has no commands', () => {
    expect(paramsOf(botInviteUrl({ clientId: '123', withCommands: false })).get('scope')).toBe(
      'bot',
    );
  });

  it('grants the voice permissions a player actually needs', () => {
    const bits = BigInt(BOT_INVITE_PERMISSIONS);
    const CONNECT = 1n << 20n;
    const SPEAK = 1n << 21n;
    const VIEW_CHANNEL = 1n << 10n;

    expect(bits & CONNECT).not.toBe(0n);
    expect(bits & SPEAK).not.toBe(0n);
    expect(bits & VIEW_CHANNEL).not.toBe(0n);
  });
});

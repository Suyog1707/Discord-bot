import { describe, expect, it } from 'vitest';

import { decideDjAuthority, SessionDjRegistry, type DjAuthorityInput } from './session-dj.js';

const BOT_VC = 'vc-bot';

/** A plain member sitting with the bot in a session somebody else hosts. */
function input(overrides: Partial<DjAuthorityInput> = {}): DjAuthorityInput {
  return {
    memberId: 'member',
    memberVoiceChannelId: BOT_VC,
    botVoiceChannelId: BOT_VC,
    hasManageGuild: false,
    hostId: 'host',
    sessionDjIds: [],
    memberRoleIds: [],
    djRoleId: null,
    djUserIds: [],
    ...overrides,
  };
}

describe('decideDjAuthority', () => {
  it('lets the session host control playback', () => {
    expect(decideDjAuthority(input({ memberId: 'host' }))).toBe('allowed');
  });

  it('lets someone the host granted DJ control playback', () => {
    expect(decideDjAuthority(input({ sessionDjIds: ['member'] }))).toBe('allowed');
  });

  it('denies a plain listener in the room', () => {
    expect(decideDjAuthority(input())).toBe('not-dj');
  });

  it('always lets Manage Server through, even from outside the channel', () => {
    const verdict = decideDjAuthority(
      input({ hasManageGuild: true, memberVoiceChannelId: null, memberId: 'admin' }),
    );

    expect(verdict).toBe('allowed');
  });

  describe('the DJ role is scoped to the session, not the guild', () => {
    it('counts for a role holder sitting with the bot', () => {
      const verdict = decideDjAuthority(input({ djRoleId: 'role-dj', memberRoleIds: ['role-dj'] }));

      expect(verdict).toBe('allowed');
    });

    /** The correction this feature exists for: the role is not a blanket grant. */
    it('counts for nothing from a different voice channel', () => {
      const verdict = decideDjAuthority(
        input({
          djRoleId: 'role-dj',
          memberRoleIds: ['role-dj'],
          memberVoiceChannelId: 'vc-elsewhere',
        }),
      );

      expect(verdict).toBe('not-in-channel');
    });

    it('counts for nothing when they are in no voice channel at all', () => {
      const verdict = decideDjAuthority(
        input({ djRoleId: 'role-dj', memberRoleIds: ['role-dj'], memberVoiceChannelId: null }),
      );

      expect(verdict).toBe('not-in-channel');
    });

    it('applies the same rule to a dashboard-named DJ', () => {
      expect(decideDjAuthority(input({ djUserIds: ['member'] }))).toBe('allowed');
      expect(
        decideDjAuthority(input({ djUserIds: ['member'], memberVoiceChannelId: 'vc-elsewhere' })),
      ).toBe('not-in-channel');
    });
  });

  describe('with no live session', () => {
    const noSession = { botVoiceChannelId: null, memberVoiceChannelId: null, hostId: null };

    /** Nothing configured: exactly the permissive behaviour guilds have today. */
    it('allows anyone when nothing is configured', () => {
      expect(decideDjAuthority(input(noSession))).toBe('allowed');
    });

    it('still honours the standing configuration', () => {
      expect(decideDjAuthority(input({ ...noSession, djRoleId: 'role-dj' }))).toBe('not-dj');
      expect(
        decideDjAuthority(input({ ...noSession, djRoleId: 'role-dj', memberRoleIds: ['role-dj'] })),
      ).toBe('allowed');
    });
  });

  /**
   * A restored 24/7 queue plays without anyone having requested anything, so
   * it has no host. Locking the room out of its own music is the worse answer.
   */
  it('stays open when a session has no host and nothing is configured', () => {
    expect(decideDjAuthority(input({ hostId: null }))).toBe('allowed');
  });

  it('but still enforces a configured DJ when the session has no host', () => {
    expect(decideDjAuthority(input({ hostId: null, djRoleId: 'role-dj' }))).toBe('not-dj');
  });
});

describe('SessionDjRegistry', () => {
  it('keeps the first host, so a later request cannot take the room over', () => {
    const registry = new SessionDjRegistry();

    registry.setHost('g1', 'first');
    registry.setHost('g1', 'second');

    expect(registry.host('g1')).toBe('first');
  });

  it('lets a deliberate claim hand the session over', () => {
    const registry = new SessionDjRegistry();

    registry.setHost('g1', 'first');
    registry.claimHost('g1', 'second');

    expect(registry.host('g1')).toBe('second');
  });

  it('grants and revokes DJ', () => {
    const registry = new SessionDjRegistry();

    registry.grant('g1', 'friend');
    expect(registry.isSessionDj('g1', 'friend')).toBe(true);
    expect(registry.djIds('g1')).toEqual(['friend']);

    expect(registry.revoke('g1', 'friend')).toBe(true);
    expect(registry.isSessionDj('g1', 'friend')).toBe(false);
  });

  it('reports a revoke of someone who never held it', () => {
    expect(new SessionDjRegistry().revoke('g1', 'stranger')).toBe(false);
  });

  it('keeps guilds apart', () => {
    const registry = new SessionDjRegistry();

    registry.setHost('g1', 'a');
    registry.grant('g1', 'b');

    expect(registry.host('g2')).toBeNull();
    expect(registry.isSessionDj('g2', 'b')).toBe(false);
  });

  it('forgets everything when the session ends', () => {
    const registry = new SessionDjRegistry();

    registry.setHost('g1', 'a');
    registry.grant('g1', 'b');
    registry.clear('g1');

    expect(registry.host('g1')).toBeNull();
    expect(registry.djIds('g1')).toEqual([]);
  });
});

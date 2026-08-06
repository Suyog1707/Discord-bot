import { describe, expect, it } from 'vitest';

import { discordAvatarUrl, guildIconUrl } from './cdn';
import { canManageGuild, hasPermission, PERMISSION_BITS } from './permissions';

describe('canManageGuild', () => {
  it('always allows the owner, whatever the bitfield says', () => {
    expect(canManageGuild('0', true)).toBe(true);
  });

  it('allows MANAGE_GUILD (0x20)', () => {
    expect(canManageGuild(String(0x20), false)).toBe(true);
  });

  it('allows ADMINISTRATOR (0x8) even without MANAGE_GUILD', () => {
    expect(canManageGuild(String(0x8), false)).toBe(true);
  });

  it('denies unrelated permissions', () => {
    // SEND_MESSAGES | CONNECT — plenty of bits, none of the right ones.
    expect(canManageGuild(String(0x800 | 0x100000), false)).toBe(false);
    expect(canManageGuild('0', false)).toBe(false);
  });

  it('handles bitfields beyond Number.MAX_SAFE_INTEGER', () => {
    // High bit set (1n << 60n) plus MANAGE_GUILD.
    const bits = (1n << 60n) | 0x20n;
    expect(canManageGuild(bits.toString(), false)).toBe(true);
  });

  it('denies malformed bitfields rather than throwing', () => {
    expect(canManageGuild('not-a-number', false)).toBe(false);
    expect(canManageGuild('', false)).toBe(false);
  });
});

describe('hasPermission', () => {
  it('checks a single bit', () => {
    expect(hasPermission(String(0x8), PERMISSION_BITS.ADMINISTRATOR)).toBe(true);
    expect(hasPermission(String(0x4), PERMISSION_BITS.ADMINISTRATOR)).toBe(false);
  });
});

describe('discordAvatarUrl', () => {
  it('builds a png URL for static avatars', () => {
    expect(discordAvatarUrl({ id: '123', avatar: 'abc' })).toBe(
      'https://cdn.discordapp.com/avatars/123/abc.png',
    );
  });

  it('builds a gif URL for animated avatars', () => {
    expect(discordAvatarUrl({ id: '123', avatar: 'a_xyz' })).toBe(
      'https://cdn.discordapp.com/avatars/123/a_xyz.gif',
    );
  });

  it('derives a stable default avatar from the user id', () => {
    const url = discordAvatarUrl({ id: '123456789012345678', avatar: null });
    expect(url).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/u);
  });

  it('tolerates a malformed id', () => {
    expect(discordAvatarUrl({ id: 'garbage', avatar: null })).toBe(
      'https://cdn.discordapp.com/embed/avatars/0.png',
    );
  });
});

describe('guildIconUrl', () => {
  it('returns null when the guild has no icon', () => {
    expect(guildIconUrl({ id: '1', icon: null })).toBeNull();
  });

  it('builds png and gif variants', () => {
    expect(guildIconUrl({ id: '1', icon: 'hash' })).toContain('/icons/1/hash.png');
    expect(guildIconUrl({ id: '1', icon: 'a_hash' })).toContain('/icons/1/a_hash.gif');
  });
});

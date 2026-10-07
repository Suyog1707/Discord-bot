import { describe, expect, it, vi } from 'vitest';
import { discordAdapter } from './adapter';

describe('Discord identity adapter', () => {
  it('reuses a bot-created user by verified Discord ID, preserving its internal ID', async () => {
    const upsert = vi.fn((_args: unknown) =>
      Promise.resolve({
        id: 'existing-user',
        discordId: '123',
        username: 'listener',
        email: null,
        emailVerified: null,
      }),
    );
    const adapter = discordAdapter({ user: { upsert } } as never);
    const user = await adapter.createUser!({
      discordId: '123',
      username: 'listener',
      email: null,
      emailVerified: null,
    } as never);
    expect(user.id).toBe('existing-user');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { discordId: '123' },
        create: expect.objectContaining({ discordId: '123' }),
      }),
    );
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('where.email');
  });
  it('refuses profiles without a verified provider identity', async () => {
    const upsert = vi.fn();
    await expect(
      discordAdapter({ user: { upsert } } as never).createUser!({
        email: 'existing@example.com',
      } as never),
    ).rejects.toThrow('Missing Discord identity');
    expect(upsert).not.toHaveBeenCalled();
  });
});

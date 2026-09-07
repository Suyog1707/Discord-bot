import { describe, expect, it, vi, beforeEach } from 'vitest';

interface AccountUpdate {
  readonly where: { provider: string; providerAccountId: string };
  readonly data: Record<string, unknown>;
}

const updateMany = vi.hoisted(() => vi.fn((_args: AccountUpdate) => Promise.resolve({ count: 1 })));
const userUpdate = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ account: { updateMany }, user: { update: userUpdate } }),
}));
vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    DISCORD_CLIENT_ID: 'id',
    DISCORD_CLIENT_SECRET: 'secret',
    NEXTAUTH_SECRET: 'secret',
  }),
  isProduction: () => false,
}));
vi.mock('@/lib/logger', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const { buildAuthConfig } = await import('./config');

/** The account shape Auth.js hands the signIn event after an OAuth exchange. */
const discordAccount = {
  provider: 'discord',
  providerAccountId: '4242',
  type: 'oauth',
  access_token: 'fresh-access',
  refresh_token: 'fresh-refresh',
  expires_at: 1_800_000_000,
  token_type: 'bearer',
  scope: 'identify email guilds',
};

async function fireSignIn(account: unknown): Promise<void> {
  const events = buildAuthConfig().events;
  await events?.signIn?.({ user: { id: 'user-1' }, account } as never);
}

describe('signIn event: Discord token persistence', () => {
  beforeEach(() => {
    updateMany.mockClear();
    userUpdate.mockClear();
  });

  /**
   * The regression. Auth.js only calls `linkAccount` for accounts it has never
   * seen, so a returning user's stored tokens were never refreshed — once the
   * refresh token was rejected with `invalid_grant`, signing in again did not
   * repair it and the dashboard stayed locked out of Discord for good.
   */
  it('rewrites the stored tokens when an existing account signs in again', async () => {
    await fireSignIn(discordAccount);

    expect(updateMany).toHaveBeenCalledWith({
      where: { provider: 'discord', providerAccountId: '4242' },
      data: {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_at: 1_800_000_000,
        token_type: 'bearer',
        scope: 'identify email guilds',
      },
    });
  });

  /** Absent must mean "leave it alone", never "overwrite the good one with null". */
  it('leaves out fields Discord did not return', async () => {
    await fireSignIn({ ...discordAccount, refresh_token: undefined, expires_at: undefined });

    const call = updateMany.mock.calls[0];
    expect(call).toBeDefined();
    const { data } = call![0];
    expect(data).not.toHaveProperty('refresh_token');
    expect(data).not.toHaveProperty('expires_at');
    expect(data.access_token).toBe('fresh-access');
  });

  it('ignores accounts from other providers', async () => {
    await fireSignIn({ ...discordAccount, provider: 'github' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** A token write that fails must not cost the user their sign-in. */
  it('still records the login when persisting the tokens fails', async () => {
    updateMany.mockRejectedValueOnce(new Error('db down'));

    await expect(fireSignIn(discordAccount)).resolves.toBeUndefined();
    expect(userUpdate).toHaveBeenCalled();
  });
});

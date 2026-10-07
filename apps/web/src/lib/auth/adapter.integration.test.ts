// @vitest-environment node
import { PrismaClient } from '@discord-music/database';
import { afterAll, describe, expect, it } from 'vitest';
import { discordAdapter } from './adapter';

// Use only a dedicated disposable database, never production.
const url = process.env.AUTH_TEST_DATABASE_URL;
describe.runIf(url !== undefined)('Discord adapter against isolated PostgreSQL', () => {
  const db = new PrismaClient({
    datasourceUrl: url ?? 'postgresql://test:test@127.0.0.1:1/music_test',
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  it('first login reuses a bot identity; sessions survive Spotify disconnect', async () => {
    const identity = `integration-${String(Date.now())}`;
    const before = await db.user.create({ data: { discordId: identity, username: 'bot-created' } });
    try {
      const adapter = discordAdapter(db);
      const user = await adapter.createUser!({
        discordId: identity,
        username: 'listener',
        globalName: null,
        avatar: null,
        locale: null,
        email: null,
        emailVerified: null,
      } as never);
      expect(user.id).toBe(before.id);
      expect(await db.user.count({ where: { discordId: identity } })).toBe(1);
      await adapter.linkAccount!({
        provider: 'discord',
        providerAccountId: identity,
        type: 'oauth',
        userId: user.id,
      });
      const token = `session-${identity}`;
      await adapter.createSession!({
        sessionToken: token,
        userId: user.id,
        expires: new Date(Date.now() + 60_000),
      });
      await db.spotifyAccount.create({
        data: {
          userId: user.id,
          spotifyId: identity,
          accessToken: 'test-only',
          refreshToken: 'test-only',
          scopes: '',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await db.spotifyAccount.deleteMany({ where: { userId: user.id } });
      expect((await adapter.getSessionAndUser!(token))?.user.id).toBe(user.id);
      expect(
        (await adapter.getUserByAccount!({ provider: 'discord', providerAccountId: identity }))?.id,
      ).toBe(user.id);
      await adapter.deleteSession!(token);
      expect(await adapter.getSessionAndUser!(token)).toBeNull();
    } finally {
      await db.user.delete({ where: { id: before.id } });
    }
  });
});

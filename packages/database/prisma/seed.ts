/**
 * Development seed.
 *
 * Idempotent — every write is an upsert, so running it repeatedly is safe.
 * Never run against production: it refuses to start when NODE_ENV=production.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEV_USER_DISCORD_ID = '100000000000000001';
const DEV_GUILD_DISCORD_ID = '200000000000000001';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const user = await prisma.user.upsert({
    where: { discordId: DEV_USER_DISCORD_ID },
    update: {},
    create: {
      discordId: DEV_USER_DISCORD_ID,
      username: 'devuser',
      globalName: 'Dev User',
      email: 'dev@example.com',
      locale: 'en-US',
    },
  });

  const guild = await prisma.guild.upsert({
    where: { discordId: DEV_GUILD_DISCORD_ID },
    update: {},
    create: {
      discordId: DEV_GUILD_DISCORD_ID,
      name: 'Dev Guild',
      ownerId: DEV_USER_DISCORD_ID,
      botJoinedAt: new Date(),
      settings: { create: {} },
    },
  });

  await prisma.guildMember.upsert({
    where: { userId_guildId: { userId: user.id, guildId: guild.id } },
    update: {},
    create: { userId: user.id, guildId: guild.id, isAdmin: true, isDj: true },
  });

  await prisma.playlist.upsert({
    where: { ownerId_name: { ownerId: user.id, name: 'Favourites' } },
    update: {},
    create: {
      ownerId: user.id,
      name: 'Favourites',
      description: 'Seeded example playlist.',
      visibility: 'PRIVATE',
    },
  });

  console.log(`Seeded user ${user.username} and guild ${guild.name}.`);
}

try {
  await main();
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

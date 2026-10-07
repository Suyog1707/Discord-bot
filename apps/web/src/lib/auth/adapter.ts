import 'server-only';

import { PrismaAdapter } from '@auth/prisma-adapter';
import type { PrismaClient } from '@discord-music/database';
import type { Adapter, AdapterUser } from 'next-auth/adapters';

/** Bot-side favorites/history can create an identity before its first OAuth
 * sign-in. Reuse only the verified Discord profile ID, never an email match. */
export function discordAdapter(db: PrismaClient): Adapter {
  return {
    ...PrismaAdapter(db),
    async createUser(profile) {
      const discord = profile as typeof profile & {
        discordId?: string;
        username?: string;
        globalName?: string | null;
        avatar?: string | null;
        locale?: string | null;
      };
      if (!discord.discordId || !discord.username) throw new Error('Missing Discord identity');
      const data = {
        username: discord.username,
        globalName: discord.globalName,
        avatar: discord.avatar ?? null,
        locale: discord.locale ?? null,
        email: discord.email,
        emailVerified: discord.emailVerified ?? null,
      };
      const user = await db.user.upsert({
        where: { discordId: discord.discordId },
        create: { discordId: discord.discordId, ...data },
        update: data,
      });
      // Like PrismaAdapter itself, adapt the nullable database email to the
      // adapter boundary. Discord accounts can legitimately have no email.
      return user as AdapterUser;
    },
  };
}

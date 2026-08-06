import 'server-only';

/**
 * Auth.js (NextAuth v5) configuration — Discord OAuth2 with database sessions
 * (docs/AUTHENTICATION.md).
 *
 * Design decisions:
 * - Database sessions (Prisma adapter), not JWTs: sessions are revocable from
 *   the dashboard and the Session model already exists for it.
 * - The Discord provider's `profile()` is shaped to this project's User model
 *   (discordId, username, globalName, avatar, locale) so the adapter persists
 *   the fields the bot and dashboard actually use.
 * - Discord access/refresh tokens land in the Account row via the adapter;
 *   `lib/discord` refreshes them on demand when calling the Discord API.
 */
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { NextAuthConfig } from 'next-auth';
import Discord, { type DiscordProfile } from 'next-auth/providers/discord';

import { discordAvatarUrl } from '@/lib/discord/cdn';
import { getDb } from '@/lib/db';
import { getEnv, isProduction } from '@/lib/env';
import { getLogger } from '@/lib/logger';

/** OAuth scopes: identity + email for the profile, guilds for the server list. */
const DISCORD_SCOPES = ['identify', 'email', 'guilds'].join(' ');

/**
 * Config is built lazily (NextAuth accepts a factory) so importing this module
 * never validates env — the same constraint every server module here follows,
 * because `next build` imports route modules to collect page data.
 */
export function buildAuthConfig(): NextAuthConfig {
  const env = getEnv();
  const logger = getLogger('auth');

  return {
    adapter: PrismaAdapter(getDb()),
    session: {
      strategy: 'database',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      updateAge: 24 * 60 * 60, // extend at most once a day
    },
    secret: env.NEXTAUTH_SECRET,
    trustHost: true,
    useSecureCookies: isProduction(),
    pages: {
      signIn: '/login',
      error: '/login',
    },
    providers: [
      Discord({
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        authorization: { params: { scope: DISCORD_SCOPES } },
        /**
         * Shape the OAuth profile to this project's User model. The adapter
         * persists exactly these fields on first sign-in.
         */
        profile(profile: DiscordProfile) {
          return {
            id: profile.id,
            discordId: profile.id,
            username: profile.username,
            globalName: profile.global_name,
            avatar: discordAvatarUrl({ id: profile.id, avatar: profile.avatar }),
            email: profile.email,
            emailVerified: profile.verified ? new Date() : null,
            locale: profile.locale,
          };
        },
      }),
    ],
    callbacks: {
      /** Expose the internal id and Discord id to server components. */
      session({ session, user }) {
        session.user.id = user.id;
        session.user.discordId = user.discordId;
        session.user.username = user.username;
        return session;
      },
    },
    events: {
      async signIn({ user }) {
        if (user.id === undefined) return;
        try {
          await getDb().user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          });
        } catch (error) {
          // Telemetry only — a failed timestamp must never break sign-in.
          logger.warn({ err: error, userId: user.id }, 'Failed to record lastLoginAt');
        }
      },
      signOut(message) {
        logger.debug({ message }, 'User signed out');
      },
    },
    logger: {
      error(error) {
        logger.error({ err: error }, 'Auth.js error');
      },
      warn(code) {
        logger.warn({ code }, 'Auth.js warning');
      },
    },
  };
}

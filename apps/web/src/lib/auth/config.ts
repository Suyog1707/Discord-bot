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
import type { NextAuthConfig } from 'next-auth';
import Discord, { type DiscordProfile } from 'next-auth/providers/discord';

import { discordAvatarUrl } from '@/lib/discord/cdn';
import { getDb } from '@/lib/db';
import { getEnv, isProduction } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { omitUndefined } from '@/lib/object';
import { discordAdapter } from './adapter';
import { authDiagnostics } from './diagnostics';

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
    adapter: discordAdapter(getDb()),
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
      async signIn({ user, account }) {
        /**
         * Re-persist the Discord tokens on *every* sign-in.
         *
         * Auth.js only calls the adapter's `linkAccount` when the account row
         * does not exist yet: signing in again with an already-linked Discord
         * account creates a fresh session but leaves the stored access and
         * refresh tokens untouched (@auth/core `handle-login`, the
         * `userByAccount` branch). Once Discord rejects the stored refresh
         * token with `invalid_grant` — it was revoked, or a rotation was lost
         * — nothing in the normal flow can ever replace it, so the dashboard
         * stays locked out of the Discord API while the database session
         * happily lives on for its full 30 days. Writing the freshly issued
         * pair here is what makes signing in again an actual repair.
         */
        if (account?.provider === 'discord' && account.providerAccountId !== '') {
          try {
            await getDb().account.updateMany({
              where: { provider: 'discord', providerAccountId: account.providerAccountId },
              // A value Discord omitted must leave the stored one alone
              // rather than nulling it, so drop the absent keys entirely.
              data: omitUndefined({
                access_token: account.access_token,
                refresh_token: account.refresh_token,
                expires_at: typeof account.expires_at === 'number' ? account.expires_at : undefined,
                token_type: account.token_type,
                scope: account.scope,
              }),
            });
          } catch (error) {
            // Never break sign-in over this; the dashboard detects a dead
            // link on the next Discord call and sends the user back here.
            logger.error({ err: error, userId: user.id }, 'Failed to persist Discord tokens');
          }
        }

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
        logger.error({ err: error, authDiagnostic: authDiagnostics(error) }, 'Auth.js error');
      },
      warn(code) {
        logger.warn({ code }, 'Auth.js warning');
      },
    },
  };
}

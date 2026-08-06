/**
 * Module augmentation: fields this app adds to the Auth.js session and user.
 *
 * `AdapterUser` mirrors the Prisma User model (the adapter returns Prisma rows),
 * and `Session.user` mirrors what the `session` callback exposes to the app.
 */
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      discordId: string;
      username: string;
    } & DefaultSession['user'];
  }

  /**
   * Required rather than optional: Discord is the only provider and its
   * `profile()` always supplies these, so downstream code (session callback,
   * adapter rows) can rely on them without null checks.
   */
  interface User {
    discordId: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    locale: string | null;
  }
}

declare module '@auth/core/adapters' {
  interface AdapterUser {
    discordId: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    locale: string | null;
  }
}

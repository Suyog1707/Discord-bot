import 'server-only';

/**
 * Session helpers for server components and route handlers.
 *
 * Two flavours per need:
 * - `getSession` / `getCurrentUser`: nullable, for UI that renders both states.
 * - `requireUser`: throws `UnauthenticatedError`, for API routes where the
 *   central error handler converts it into a 401 envelope.
 * - `requireUserOrRedirect`: for pages, redirecting to /login with a callback.
 */
import { UnauthenticatedError } from '@discord-music/shared';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Session } from 'next-auth';

import { auth } from './index';

/**
 * Per-request memo of the Auth.js database session lookup.
 *
 * With `strategy: 'database'` every `auth()` call is a Postgres round trip
 * (session join user). A single navigation calls it from the dashboard layout
 * *and* the page — and again from any server action on that page — so an
 * uncached `auth()` multiplied the session query by the number of callers.
 * React's `cache` collapses them to one lookup per request; it is a request
 * scope, not a cross-request cache, so revocation stays immediate.
 */
const cachedAuth = cache(async (): Promise<Session | null> => auth());

export interface SessionUser {
  readonly id: string;
  readonly discordId: string;
  readonly username: string;
  readonly email: string | null | undefined;
  readonly image: string | null | undefined;
}

export async function getSession(): Promise<Session | null> {
  return cachedAuth();
}

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await cachedAuth();
  if (!session?.user.id) return null;

  return {
    id: session.user.id,
    discordId: session.user.discordId,
    username: session.user.username,
    email: session.user.email,
    image: session.user.image,
  };
});

/** For API routes: throw so the route wrapper returns a structured 401. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user === null) {
    throw new UnauthenticatedError();
  }
  return user;
}

/** For pages: bounce unauthenticated visitors to /login, preserving the target. */
export async function requireUserOrRedirect(callbackUrl: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user === null) {
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  return user;
}

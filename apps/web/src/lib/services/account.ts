import 'server-only';

/**
 * Account self-service: profile summary, active sessions, revocation.
 * Everything is scoped to the requesting user — there is no admin surface here.
 */
import { NotFoundError } from '@discord-music/shared';

import { getDb } from '@/lib/db';

export async function getProfile(userId: string) {
  const db = getDb();
  const [user, playlistCount] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        discordId: true,
        username: true,
        globalName: true,
        avatar: true,
        email: true,
        createdAt: true,
        lastLoginAt: true,
      },
    }),
    db.playlist.count({ where: { ownerId: userId } }),
  ]);

  if (user === null) throw new NotFoundError('Account not found.');

  return { ...user, playlistCount };
}

export interface SessionView {
  readonly id: string;
  readonly current: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly expires: Date;
}

export async function listSessions(
  userId: string,
  currentSessionToken: string | null,
): Promise<readonly SessionView[]> {
  const sessions = await getDb().session.findMany({
    where: { userId, expires: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sessionToken: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      expires: true,
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    current: currentSessionToken !== null && session.sessionToken === currentSessionToken,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    expires: session.expires,
  }));
}

/** Revoke one session by id (scoped to the owner). */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const { count } = await getDb().session.deleteMany({ where: { id: sessionId, userId } });
  if (count === 0) throw new NotFoundError('Session not found.');
}

/** Revoke every session except the current one ("sign out other devices"). */
export async function revokeOtherSessions(
  userId: string,
  currentSessionToken: string | null,
): Promise<number> {
  const { count } = await getDb().session.deleteMany({
    where: {
      userId,
      ...(currentSessionToken === null ? {} : { sessionToken: { not: currentSessionToken } }),
    },
  });
  return count;
}

import 'server-only';

/**
 * Composition helper for authenticated API routes.
 *
 * Every JSON endpoint gets the same pipeline in the same order:
 *   error envelope → session check (401) → per-user rate limit (429) → handler
 *
 * so an individual route file only contains its own logic.
 */
import type { NextRequest, NextResponse } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export interface AuthedRouteArgs<TParams> {
  readonly user: SessionUser;
  readonly request: NextRequest;
  readonly params: TParams;
}

type RouteKind = keyof typeof RATE_LIMITS;

/**
 * @param route - Stable name used for logging and the rate-limit bucket,
 *   e.g. `"GET /api/server"`.
 * @param kind - Which rate-limit profile applies (`read`/`write`/`control`).
 */
export function authedRoute<TParams = Record<string, never>>(
  route: string,
  kind: RouteKind,
  handler: (args: AuthedRouteArgs<TParams>) => Promise<NextResponse>,
): (request: NextRequest, context: { params: Promise<TParams> }) => Promise<NextResponse> {
  return withErrorHandling(route, async (request, context) => {
    const user = await requireUser();
    await enforceRateLimit({ identity: user.id, bucket: route, ...RATE_LIMITS[kind] });
    return handler({ user, request, params: await context.params });
  });
}

/** Parse a JSON body, tolerating an empty one (returns `undefined`). */
export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** The Auth.js session cookie value on this request, for current-session marking. */
export function currentSessionToken(request: NextRequest): string | null {
  return (
    request.cookies.get('__Secure-authjs.session-token')?.value ??
    request.cookies.get('authjs.session-token')?.value ??
    null
  );
}

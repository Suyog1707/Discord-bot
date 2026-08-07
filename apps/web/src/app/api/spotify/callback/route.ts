/**
 * GET /api/spotify/callback — complete the OAuth flow.
 *
 * Validates the CSRF state cookie, exchanges the code, stores encrypted
 * tokens, and lands the user back on the settings page with an outcome flag.
 * OAuth errors (user pressed cancel, bad state) redirect with an error code
 * rather than rendering a raw API error page.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { completeLink } from '@/lib/services/spotify';
import { STATE_COOKIE } from '../authorize/route';

export const dynamic = 'force-dynamic';

function settingsRedirect(outcome: string): NextResponse {
  const response = NextResponse.redirect(
    `${getEnv().NEXTAUTH_URL}/dashboard/settings?spotify=${outcome}`,
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}

export const GET = withErrorHandling('GET /api/spotify/callback', async (request: NextRequest) => {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;

  if (params.get('error') !== null) return settingsRedirect('denied');

  const code = params.get('code');
  const state = params.get('state');
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  if (code === null || state === null || expectedState === undefined || state !== expectedState) {
    return settingsRedirect('invalid');
  }

  try {
    await completeLink(user.id, code);
  } catch (error) {
    getLogger('spotify').warn({ err: error, userId: user.id }, 'Spotify link failed');
    return settingsRedirect('failed');
  }
  return settingsRedirect('linked');
});

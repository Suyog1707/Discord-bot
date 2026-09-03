import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { getLogger } from '@/lib/logger';
import { completeLink } from '@/lib/services/spotify';
import { STATE_COOKIE } from '../authorize/route';

export const dynamic = 'force-dynamic';

function settingsRedirect(request: NextRequest, outcome: string): NextResponse {
  const redirectUrl = new URL('/dashboard/settings', request.url);
  redirectUrl.searchParams.set('spotify', outcome);

  const response = NextResponse.redirect(redirectUrl);
  response.cookies.delete(STATE_COOKIE);

  return response;
}

export const GET = withErrorHandling('GET /api/spotify/callback', async (request: NextRequest) => {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;

  if (params.get('error') !== null) {
    return settingsRedirect(request, 'denied');
  }

  const code = params.get('code');
  const state = params.get('state');
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;

  if (code === null || state === null || expectedState === undefined || state !== expectedState) {
    return settingsRedirect(request, 'invalid');
  }

  try {
    await completeLink(user.id, code);
  } catch (error) {
    getLogger('spotify').warn({ err: error, userId: user.id }, 'Spotify link failed');

    return settingsRedirect(request, 'failed');
  }

  return settingsRedirect(request, 'linked');
});

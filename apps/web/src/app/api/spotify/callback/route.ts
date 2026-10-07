import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { getLogger } from '@/lib/logger';
import { publicUrl } from '@/lib/public-origin';
import { completeLink } from '@/lib/services/spotify';
import { STATE_COOKIE } from '../authorize/route';

export const dynamic = 'force-dynamic';

function settingsRedirect(outcome: string): NextResponse {
  const redirectUrl = publicUrl('/dashboard/settings');
  redirectUrl.searchParams.set('spotify', outcome);

  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(STATE_COOKIE, '', { path: '/api/spotify', maxAge: 0 });

  return response;
}

export const GET = withErrorHandling('GET /api/spotify/callback', async (request: NextRequest) => {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;

  if (params.get('error') !== null) {
    return settingsRedirect('denied');
  }

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

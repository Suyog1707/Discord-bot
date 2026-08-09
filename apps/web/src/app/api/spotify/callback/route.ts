import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { getLogger } from '@/lib/logger';
import { completeLink } from '@/lib/services/spotify';
import { STATE_COOKIE } from '../authorize/route';

export const dynamic = 'force-dynamic';

const LOCALHOST_CALLBACK =
  'http://localhost:3000/api/spotify/callback';

function settingsRedirect(outcome: string): NextResponse {
  const response = NextResponse.redirect(
    `http://localhost:3000/dashboard/settings?spotify=${outcome}`,
  );

  response.cookies.delete(STATE_COOKIE);

  return response;
}

export const GET = withErrorHandling(
  'GET /api/spotify/callback',
  async (request: NextRequest) => {
    /*
     * Spotify requires the registered OAuth callback to use 127.0.0.1.
     *
     * Our application authentication cookie belongs to localhost.
     *
     * Therefore the first request is:
     *
     * 127.0.0.1:3000/api/spotify/callback
     *
     * and we immediately move it to:
     *
     * localhost:3000/api/spotify/callback
     *
     * while preserving code/state/error query parameters.
     */

    if (request.nextUrl.hostname === '127.0.0.1') {
      const redirectUrl = new URL(LOCALHOST_CALLBACK);

      request.nextUrl.searchParams.forEach((value, key) => {
        redirectUrl.searchParams.set(key, value);
      });

      return NextResponse.redirect(redirectUrl);
    }

    /*
     * From this point onward we should be on localhost,
     * where the user's authentication cookie exists.
     */
    const user = await requireUser();

    const params = request.nextUrl.searchParams;

    if (params.get('error') !== null) {
      return settingsRedirect('denied');
    }

    const code = params.get('code');
    const state = params.get('state');
    const expectedState = request.cookies.get(STATE_COOKIE)?.value;

    if (
      code === null ||
      state === null ||
      expectedState === undefined ||
      state !== expectedState
    ) {
      return settingsRedirect('invalid');
    }

    try {
      await completeLink(user.id, code);
    } catch (error) {
      getLogger('spotify').warn(
        { err: error, userId: user.id },
        'Spotify link failed',
      );

      return settingsRedirect('failed');
    }

    return settingsRedirect('linked');
  },
);
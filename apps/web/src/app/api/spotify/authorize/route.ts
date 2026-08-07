/**
 * GET /api/spotify/authorize — begin the Spotify OAuth flow.
 *
 * The random `state` goes into an httpOnly cookie and must round-trip
 * unchanged through Spotify — the callback rejects any mismatch (CSRF).
 */
import { randomBytes } from 'node:crypto';

import { UpstreamError } from '@discord-music/shared';
import { NextResponse } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { isProduction } from '@/lib/env';
import { authorizeUrl, isSpotifyConfigured } from '@/lib/spotify/client';

export const dynamic = 'force-dynamic';

export const STATE_COOKIE = 'spotify_oauth_state';

export const GET = withErrorHandling('GET /api/spotify/authorize', async () => {
  await requireUser();
  if (!isSpotifyConfigured()) {
    throw new UpstreamError(
      'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
    );
  }

  const state = randomBytes(24).toString('base64url');
  const response = NextResponse.redirect(authorizeUrl(state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    maxAge: 600,
    path: '/api/spotify',
  });
  return response;
});

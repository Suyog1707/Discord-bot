/**
 * Edge middleware guarding the dashboard.
 *
 * Database sessions cannot be verified here — the edge runtime has no Prisma —
 * so this performs only a fast cookie-presence check to bounce obviously
 * unauthenticated visitors before any server work. The authoritative check
 * runs in the dashboard layout via `requireUserOrRedirect`, which validates
 * the session against the database. A forged cookie gets past the middleware
 * and is rejected there.
 */
import { NextResponse, type NextRequest } from 'next/server';

/** Auth.js session cookie names (secure prefix is used behind HTTPS). */
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

export function middleware(request: NextRequest): NextResponse {
  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasSessionCookie) {
    const login = new URL('/login', request.url);
    login.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};

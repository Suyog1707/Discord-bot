/* eslint-disable no-restricted-syntax -- Edge middleware cannot import the Node-only env loader. */
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
  // Opt-in until the local Funnel hostname and gateway secret are configured
  // in Vercel. A partially configured proxy fails closed instead of letting
  // Vercel execute its old direct database-backed routes.
  if (process.env.VERCEL === '1' && process.env.BACKEND_PROXY_ENABLED === 'true') {
    const backendUrl = process.env.BACKEND_PROXY_URL;
    const secret = process.env.ORIGIN_SECRET;
    if (!backendUrl || !secret) {
      return NextResponse.json({ error: 'Backend proxy is not configured.' }, { status: 503 });
    }

    let backend: URL;
    try {
      backend = new URL(backendUrl);
    } catch {
      return NextResponse.json({ error: 'Backend proxy URL is invalid.' }, { status: 503 });
    }
    if (
      backend.protocol !== 'https:' ||
      backend.username ||
      backend.password ||
      backend.search ||
      backend.hash ||
      backend.pathname !== '/' ||
      backend.host === request.nextUrl.host
    ) {
      return NextResponse.json(
        { error: 'Backend proxy requires a separate HTTPS origin.' },
        { status: 503 },
      );
    }

    const destination = new URL(request.nextUrl.pathname + request.nextUrl.search, backend);
    const headers = new Headers(request.headers);
    headers.delete('x-origin-secret');
    headers.delete('x-public-host');
    headers.set('X-Origin-Secret', secret);
    headers.set('X-Public-Host', request.nextUrl.host);
    return NextResponse.rewrite(destination, { request: { headers } });
  }

  // The matcher also covers non-dashboard paths so the optional Vercel proxy
  // can route everything. Preserve the original local/dashboard behavior.
  if (
    request.nextUrl.pathname !== '/dashboard' &&
    !request.nextUrl.pathname.startsWith('/dashboard/')
  ) {
    return NextResponse.next();
  }

  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasSessionCookie) {
    const login = new URL('/login', request.url);
    login.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/:path*'],
};

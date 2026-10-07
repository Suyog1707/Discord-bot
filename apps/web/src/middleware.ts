/* eslint-disable no-restricted-syntax -- Edge middleware cannot import the Node-only env loader. */
/**
 * Edge middleware guarding the dashboard and forwarding Vercel traffic.
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
  const localBackend = process.env.WEB_BACKEND_LOCAL === 'true';
  const proxyEnabled = process.env.BACKEND_PROXY_ENABLED === 'true';
  if (localBackend && proxyEnabled) {
    return NextResponse.json({ error: 'Conflicting web backend modes.' }, { status: 503 });
  }

  // Opt-in until the local Funnel hostname and gateway secret are configured
  // in Vercel. A partially configured proxy fails closed instead of letting
  // Vercel execute its old direct database-backed routes.
  if (proxyEnabled) {
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
    if (backend.protocol !== 'https:') {
      return NextResponse.json({ error: 'Backend proxy URL must use HTTPS.' }, { status: 503 });
    }
    if (backend.username || backend.password) {
      return NextResponse.json(
        { error: 'Backend proxy URL cannot contain credentials.' },
        { status: 503 },
      );
    }
    if (backend.host === request.nextUrl.host) {
      return NextResponse.json(
        { error: 'Backend proxy URL must differ from the public website host.' },
        { status: 503 },
      );
    }

    // Use only the HTTPS origin. A pasted path/query/fragment is ignored rather
    // than becoming a prefix for every public route or leaking into requests.
    const destination = new URL(request.nextUrl.pathname + request.nextUrl.search, backend.origin);
    const headers = new Headers(request.headers);
    headers.delete('x-origin-secret');
    headers.delete('x-public-host');
    headers.set('X-Origin-Secret', secret);
    headers.set('X-Public-Host', request.nextUrl.host);
    const response = NextResponse.rewrite(destination, { request: { headers } });
    response.headers.set('X-Music-Proxy-Mode', 'forward');
    return response;
  }

  // Once cut over, Vercel must never fall back to its legacy direct database
  // routes if an environment variable disappears or a deployment is mis-set.
  if (!localBackend) {
    return NextResponse.json({ error: 'Backend proxy is disabled.' }, { status: 503 });
  }

  // The matcher also covers non-dashboard paths so the optional Vercel proxy
  // can route everything. Preserve the original local/dashboard behavior.
  if (
    request.nextUrl.pathname !== '/dashboard' &&
    !request.nextUrl.pathname.startsWith('/dashboard/')
  ) {
    const response = NextResponse.next();
    response.headers.set('X-Music-Proxy-Mode', 'off');
    return response;
  }

  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasSessionCookie) {
    // Docker's request URL can be 0.0.0.0:3000 even with a public Host.
    // Production redirects must use the configured website, not that address.
    const configured = process.env.NEXTAUTH_URL;
    if (!configured && process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Public website URL is not configured.' }, { status: 503 });
    }
    let login: URL;
    try {
      login = new URL('/login', configured ?? request.url);
      if (
        login.username ||
        login.password ||
        login.hostname === '0.0.0.0' ||
        (process.env.NODE_ENV === 'production' && login.protocol !== 'https:')
      ) {
        return NextResponse.json({ error: 'Public website URL is invalid.' }, { status: 503 });
      }
    } catch {
      return NextResponse.json({ error: 'Public website URL is invalid.' }, { status: 503 });
    }
    login.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/:path*'],
};

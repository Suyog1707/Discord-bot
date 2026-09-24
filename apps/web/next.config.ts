import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { NextConfig } from 'next';

/**
 * Load the monorepo-root `.env`.
 *
 * Next only reads env files next to the app, but this repo keeps a single
 * `.env` at the root so the web app and the bot cannot drift. Values already
 * present in the environment (Vercel, CI, the shell) win, so this only fills
 * gaps during local development.
 */
const rootEnvPath = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

/**
 * Content-Security-Policy.
 *
 * Origins are the ones this app actually uses: Discord CDN for avatars/guild
 * icons, YouTube/Spotify CDNs for artwork. `'unsafe-inline'` on script/style
 * is required by Next's inline runtime and Tailwind's injected styles; a
 * nonce-based policy is the known upgrade path once per-request middleware
 * nonces are worth the complexity.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://i.ytimg.com https://i.scdn.co",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Security headers applied to every response (docs/SECURITY.md). */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),

  experimental: {
    /**
     * Client-side Router Cache lifetimes, in seconds.
     *
     * Next 15 defaults `dynamic` to 0, so every dashboard page — all of them
     * `force-dynamic` — was re-fetched from the server on every visit,
     * including going back to a page opened seconds earlier. Holding the RSC
     * payload for 30s makes back/forward and re-visits render from memory with
     * no round trip at all. Server actions still call `revalidatePath`, which
     * evicts these entries, so writes remain visible immediately.
     */
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },

  typescript: {
    // Never ship a build that does not typecheck.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Linting runs as its own Turborepo task; skip the duplicate pass here.
    ignoreDuringBuilds: true,
  },

  // Workspace packages ship ESM + .d.ts already, but transpiling keeps them
  // debuggable and lets Next tree-shake across the boundary.
  transpilePackages: ['@discord-music/shared', '@discord-music/database'],

  serverExternalPackages: ['@prisma/client', 'ioredis', 'pino'],

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
      { protocol: 'https', hostname: 'media.discordapp.net' },
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'i.scdn.co' },
    ],
  },

  headers: () => Promise.resolve([{ source: '/:path*', headers: [...securityHeaders] }]),
};

export default nextConfig;

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
 * Security headers applied to every response (docs/SECURITY.md).
 *
 * A full Content-Security-Policy is added in Phase 2, once Auth.js and the
 * Discord CDN origins the dashboard actually loads from are known — a CSP
 * written before then would either be wrong or so permissive it is pointless.
 */
const securityHeaders = [
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

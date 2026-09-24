#!/usr/bin/env node
/** Fail a production build if Next.js did not actually bundle the proxy. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifestPath = join(process.cwd(), '.next/server/middleware-manifest.json');
let routes;
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  routes = Object.keys(manifest.middleware ?? {});
} catch (error) {
  console.error(`Cannot read Next.js middleware manifest: ${error.message}`);
  process.exit(1);
}

if (!routes.includes('/')) {
  console.error('Production build has no root middleware; Vercel proxy would not run.');
  process.exit(1);
}
console.log('Production middleware route verified.');

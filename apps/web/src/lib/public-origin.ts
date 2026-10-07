import 'server-only';

import { getEnv } from '@/lib/env';

/** Redirects use deployment configuration, never Docker's listening address
 * or an attacker-controlled Host header. */
export function publicUrl(path: string): URL {
  const env = getEnv();
  const origin = new URL(env.NEXTAUTH_URL);
  if (
    origin.username ||
    origin.password ||
    origin.hostname === '0.0.0.0' ||
    (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
  ) {
    throw new Error('NEXTAUTH_URL must be the public HTTPS website URL');
  }
  const target = new URL(path, origin.origin);
  if (target.origin !== origin.origin) throw new Error('External redirect is not allowed');
  return target;
}

import 'server-only';

/**
 * Auth.js entry point.
 *
 * `NextAuth` is called with a factory so configuration (and therefore env
 * validation) is deferred until the first request, keeping `next build` free of
 * secret requirements.
 */
import NextAuth from 'next-auth';

import { buildAuthConfig } from './config';

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);

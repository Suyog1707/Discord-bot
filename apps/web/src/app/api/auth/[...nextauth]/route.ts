/**
 * Auth.js catch-all route: /api/auth/signin, /callback/discord, /session, etc.
 * All behaviour lives in `@/lib/auth`; this file only re-exports the handlers.
 */
import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;

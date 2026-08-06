/**
 * Browser-safe environment.
 *
 * Only `NEXT_PUBLIC_*` values, still validated — a typo in the deployment
 * config should surface as a clear error rather than as `undefined` rendered
 * into a URL.
 */
import { loadPublicEnv, type PublicEnv } from '@discord-music/shared/env';

export const publicEnv: PublicEnv = loadPublicEnv();

export type { PublicEnv };

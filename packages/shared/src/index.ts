/**
 * `@discord-music/shared` — isomorphic entry point.
 *
 * Only browser-safe modules are re-exported here. Node-only concerns are behind
 * explicit subpaths so importing this barrel from a React client component
 * never drags `pino` or `ioredis` into the browser bundle:
 *
 *   import { ... } from '@discord-music/shared';        // types, constants, errors, zod
 *   import { loadBotEnv } from '@discord-music/shared/env';
 *   import { createLogger } from '@discord-music/shared/logger';
 *   import { createRedisClient } from '@discord-music/shared/redis';
 */
export * from './constants/index.js';
export * from './errors/index.js';
export * from './net/index.js';
export * from './player-commands/index.js';
export * from './player-events/index.js';
export * from './types/index.js';
export * from './validation/index.js';

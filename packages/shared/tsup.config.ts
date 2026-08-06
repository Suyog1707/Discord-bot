import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: {
    index: 'src/index.ts',
    'env/index': 'src/env/index.ts',
    'logger/index': 'src/logger/index.ts',
    'redis/index': 'src/redis/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  /**
   * Never wipe `dist/` in watch mode.
   *
   * `turbo run dev` builds this package first, then starts every dev task in
   * parallel. A cleaning watcher would delete the freshly built output while
   * the bot and web app are already resolving imports from it, so they would
   * intermittently fail with ERR_MODULE_NOT_FOUND. Watch rebuilds overwrite in
   * place instead; `build` still starts from a clean directory.
   */
  clean: !options.watch,
  treeshake: true,
  splitting: true,
  // Keep runtime deps external so consumers resolve a single instance.
  external: ['ioredis', 'pino', 'pino-pretty', 'zod'],
}));

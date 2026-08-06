import { defineConfig } from 'tsup';

export default defineConfig({
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
  clean: true,
  treeshake: true,
  splitting: true,
  // Keep runtime deps external so consumers resolve a single instance.
  external: ['ioredis', 'pino', 'pino-pretty', 'zod'],
});

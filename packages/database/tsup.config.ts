import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  // See packages/shared/tsup.config.ts: cleaning during watch would delete
  // output that the apps are concurrently resolving.
  clean: !options.watch,
  treeshake: true,
  // The generated client must stay external — it is resolved at runtime.
  external: ['@prisma/client', '.prisma/client'],
}));

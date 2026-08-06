import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // The generated client must stay external — it is resolved at runtime.
  external: ['@prisma/client', '.prisma/client'],
});

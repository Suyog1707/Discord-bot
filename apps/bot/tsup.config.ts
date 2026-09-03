import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/scripts/deploy-commands.ts',
    'src/commands/**/*.ts',
    'src/events/**/*.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Bundle workspace packages so the Docker image ships a self-contained build.
  noExternal: [/^@discord-music\//],
  external: ['discord.js', 'shoukaku', '@prisma/client', 'pino', 'pino-pretty', 'ioredis'],
  // Every entry point is a separate bundle, and without splitting esbuild
  // inlines a private copy of the shared code into each one — including the
  // AppError classes, whose duplicated identity broke `instanceof` across
  // chunk boundaries. Splitting hoists shared modules into common chunks so
  // there is exactly one of each class (and one copy of each module-level
  // singleton) at runtime. Chunks land in the outDir root, clear of the
  // dist/commands and dist/events trees the registries scan.
  splitting: true,
  dts: false,
});

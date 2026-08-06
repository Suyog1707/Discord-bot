import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/scripts/deploy-commands.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Bundle workspace packages so the Docker image ships a self-contained build.
  noExternal: [/^@discord-music\//],
  external: ['discord.js', 'shoukaku', '@prisma/client', 'pino', 'pino-pretty', 'ioredis'],
  splitting: false,
  dts: false,
});

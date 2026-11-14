import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['apps/server/src/index.ts', 'apps/worker/src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  splitting: true,
  sourcemap: true,
  target: 'node24',
  platform: 'node',
  // node:sqlite has no bare-name equivalent; preserving node: is required.
  removeNodeProtocol: false,
});

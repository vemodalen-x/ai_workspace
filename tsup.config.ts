import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['apps/server/src/index.ts', 'apps/worker/src/index.ts', 'apps/launcher/src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: ['!web/**', '!visual-review.html'],
  splitting: true,
  sourcemap: true,
  target: 'node24',
  platform: 'node',
  // node:sqlite has no bare-name equivalent; preserving node: is required.
  removeNodeProtocol: false,
});

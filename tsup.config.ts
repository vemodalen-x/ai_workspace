import { execFileSync } from 'node:child_process';
import { defineConfig } from 'tsup';

function buildCommit() {
  const supplied = process.env.WORKSPACE_BUILD_COMMIT;
  if (supplied !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(supplied)) throw new Error('Invalid WORKSPACE_BUILD_COMMIT');
    return supplied;
  }
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return git(['status', '--porcelain']) ? null : git(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

export default defineConfig(() => ({
  define: { __WORKSPACE_BUILD_COMMIT__: JSON.stringify(buildCommit()) },
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
}));

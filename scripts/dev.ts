import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const env = {
  ...process.env,
  ...(process.env.WORKSPACE_E2E_ISOLATED === '1'
    ? { WORKSPACE_DATA_DIR: mkdtempSync(resolve(tmpdir(), 'workspace-browser-test-')) }
    : {}),
  ...(process.env.SITES_MANAGED_LINUX_CONTAINER === '1'
    ? { WORKSPACE_ALLOWED_ORIGINS: 'http://terminal.local:4173' }
    : {}),
};
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    stdio: 'inherit',
    env,
  }),
  spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      '--config',
      'apps/web/vite.config.ts',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  process.exitCode = code;
}
for (const c of children) {
  c.on('error', (e) => {
    console.error(e.message);
    stop(1);
  });
  c.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

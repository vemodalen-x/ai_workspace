import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('compiled production server serves Web/API and releases its lock on shutdown', async () => {
  const data = await mkdtemp(join(tmpdir(), 'agent-workspace-production-'));
  const child = spawn(process.execPath, [resolve('dist/server/src/index.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: data, API_PORT: '4398' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = once(child, 'exit');
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('http://127.0.0.1:4398')) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code) reject(new Error(stderr));
      });
    });
    const web = await fetch('http://127.0.0.1:4398');
    assert.equal(web.status, 200);
    assert.match(await web.text(), /AI Agent Workspace/);
    const { token } = (await (await fetch('http://127.0.0.1:4398/api/bootstrap')).json()) as {
      token: string;
    };
    const state = await fetch('http://127.0.0.1:4398/api/snapshot', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);
    assert.ok(((await state.json()) as { nodes: unknown[] }).nodes.length > 0);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
  assert.equal(child.exitCode, 0, stderr);
  await assert.rejects(access(join(data, 'server.lock')));
});

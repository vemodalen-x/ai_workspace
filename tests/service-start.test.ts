import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  access,
  symlink,
  readdir,
  rm,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareServiceLock } from '../scripts/service-start.mjs';
import { sshNodeInput } from '../packages/orchestration/remote.ts';

async function directory() {
  return mkdtemp(join(tmpdir(), 'workspace-service-lock-'));
}

test('service recovery refuses live and malformed locks without changing them', async () => {
  const dir = await directory();
  try {
    const lock = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await writeFile(join(dir, 'server.lock'), lock);
    await assert.rejects(prepareServiceLock(dir, 'current-boot'), /still alive/);
    assert.equal(await readFile(join(dir, 'server.lock'), 'utf8'), lock);
    for (const invalid of ['not JSON', '{}', '{"pid":-1}', '{"pid":1.5}']) {
      await writeFile(join(dir, 'server.lock'), invalid);
      await assert.rejects(prepareServiceLock(dir, 'current-boot'));
      assert.equal(await readFile(join(dir, 'server.lock'), 'utf8'), invalid);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('service recovery archives only a confirmed dead process lock and leaves database intact', async () => {
  const dir = await directory();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const closed = once(child, 'exit');
  child.kill('SIGKILL');
  await closed;
  try {
    const lock = JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() });
    await writeFile(join(dir, 'server.lock'), lock);
    await writeFile(join(dir, 'workspace.db'), 'unchanged');
    await prepareServiceLock(dir, 'current-boot');
    await assert.rejects(access(join(dir, 'server.lock')));
    const archive = (await readdir(dir)).find((name) => name.startsWith('server.lock.recovered-'))!;
    assert.equal(await readFile(join(dir, archive), 'utf8'), lock);
    assert.equal(await readFile(join(dir, 'workspace.db'), 'utf8'), 'unchanged');
    await prepareServiceLock(dir, 'current-boot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('boot identity permits recovery after reboot despite an unrelated reused PID', async () => {
  const dir = await directory();
  try {
    const lock = { pid: process.pid, startedAt: 'previous-start' };
    await writeFile(join(dir, 'server.lock'), JSON.stringify(lock));
    await writeFile(
      join(dir, '.service-owner.json'),
      JSON.stringify({ ...lock, bootId: 'previous-boot' }),
    );
    await prepareServiceLock(dir, 'current-boot');
    await assert.rejects(access(join(dir, 'server.lock')));
    // Non-matching metadata must never bypass the live-process check.
    await writeFile(
      join(dir, 'server.lock'),
      JSON.stringify({ ...lock, startedAt: 'different-start' }),
    );
    await assert.rejects(prepareServiceLock(dir, 'current-boot'), /still alive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('service recovery refuses symlinks instead of renaming their targets', async () => {
  if (process.platform === 'win32') return;
  const dir = await directory();
  try {
    const target = join(dir, 'target');
    await writeFile(target, 'untouched');
    await symlink(target, join(dir, 'server.lock'));
    await assert.rejects(prepareServiceLock(dir, 'current-boot'), /non-regular/);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persisted SSH nodes retain their validated absolute Node executable path', () => {
  const node = {
    name: 'Worker',
    sshAlias: 'worker',
    workerPath: '/srv/worker.js',
    nodePath: '/opt/node/bin/node',
    cpu: 4,
    ramMb: 8192,
  };
  assert.equal(sshNodeInput.parse(node).nodePath, node.nodePath);
  for (const path of ['/tmp/../node', '/tmp/node;echo', '/tmp/a b', 'relative/node'])
    assert.equal(sshNodeInput.safeParse({ ...node, nodePath: path }).success, false);
});

// Releases are selected through a `current` symlink by the production unit.
test('launcher starts when its entrypoint is reached through a release symlink', async () => {
  const dir = await directory();
  try {
    await mkdir(join(dir, 'dist/server/src'), { recursive: true });
    await writeFile(join(dir, 'dist/server/src/index.js'), 'console.log("LAUNCHER_STARTED");');
    await symlink(resolve('scripts/service-start.mjs'), join(dir, 'launcher.mjs'));
    const child = spawn(process.execPath, [join(dir, 'launcher.mjs')], {
      cwd: dir,
      env: { ...process.env, WORKSPACE_DATA_DIR: join(dir, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.match(output, /LAUNCHER_STARTED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

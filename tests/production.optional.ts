import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, access, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('compiled production server serves Web/API and releases its lock on shutdown', async () => {
  const data = await mkdtemp(join(tmpdir(), 'agent-workspace-production-'));
  const codex = join(data, 'codex');
  const claude = join(data, 'claude');
  await mkdir(join(codex, 'sessions'), { recursive: true });
  await mkdir(claude);
  await writeFile(
    join(codex, 'sessions', 'rollout-fixture.jsonl'),
    [
      {
        type: 'session_meta',
        payload: { id: 'fixture-monitor-production', cwd: data, source: 'cli' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Production Monitor fixture' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const child = spawn(process.execPath, [resolve('dist/server/src/index.js')], {
    env: {
      ...process.env,
      WORKSPACE_DATA_DIR: data,
      CODEX_HOME: codex,
      CLAUDE_CONFIG_DIR: claude,
      API_PORT: '4398',
    },
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
    const { token, buildCommit } = (await (
      await fetch('http://127.0.0.1:4398/api/bootstrap')
    ).json()) as {
      token: string;
      buildCommit: string | null;
    };
    const state = await fetch('http://127.0.0.1:4398/api/snapshot', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);
    assert.ok(((await state.json()) as { nodes: unknown[] }).nodes.length > 0);
    const monitor = await fetch('http://127.0.0.1:4398/api/monitor/overview', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(monitor.status, 200);
    const { sessions } = (await monitor.json()) as { sessions: { title: string }[] };
    assert.ok(sessions.some((session) => session.title === 'Production Monitor fixture'));
    let expected = process.env.WORKSPACE_BUILD_COMMIT ?? null;
    if (!expected) {
      const git = (args: string[]) =>
        execFileSync('git', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      try {
        if (!git(['status', '--porcelain'])) expected = git(['rev-parse', 'HEAD']);
      } catch {
        // Source archives can build without Git metadata.
      }
    }
    assert.equal(buildCommit, expected);
    execFileSync(
      process.execPath,
      [resolve('scripts/service-health.mjs'), ...(expected ? ['--expect-commit', expected] : [])],
      {
        env: { ...process.env, API_PORT: '4398' },
        timeout: 10_000,
      },
    );
  } finally {
    child.kill('SIGTERM');
    await closed;
    await assert.rejects(access(join(data, 'server.lock')));
    await rm(data, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0, stderr);
});

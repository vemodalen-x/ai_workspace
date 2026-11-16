import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Project, Snapshot, StoredEvent, Task, Run } from '../packages/shared/index.ts';
import type { AttemptOutput, Trial, TrialAttempt } from '../packages/shared/trials.ts';
import manifest from '../package.json' with { type: 'json' };

const exec = promisify(execFile);
const installed = resolve(process.argv[2]);
const sandbox = await mkdtemp(join(tmpdir(), 'installed workspace '));
const repo = join(sandbox, 'personal project');
const data = join(sandbox, 'workspace data');
const windows = process.platform === 'win32';
const runtime = join(installed, 'runtime', windows ? 'node.exe' : 'node');
const launcher = join(installed, 'dist/launcher/src/index.js');
const env = {
  ...process.env,
  WORKSPACE_DATA_DIR: data,
  API_PORT: '0',
  WORKSPACE_CODEX_READ_ONLY: '1',
};
const command = async (...args: string[]) =>
  (await exec(runtime, [launcher, ...args], { cwd: sandbox, env, timeout: 90000 })).stdout.trim();
const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trim();
let address = '',
  token = '';
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(address + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(path + ' ' + res.status + ' ' + (await res.text()).slice(0, 1000));
  return res.json() as Promise<T>;
}
async function connect() {
  address = await command('start', '--no-browser');
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
  const bootstrap = await api<{ version: string; token: string }>('bootstrap');
  assert.equal(bootstrap.version, manifest.version);
  token = bootstrap.token;
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 60000): Promise<T> {
  const until = Date.now() + timeout;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await delay(300);
  } while (Date.now() < until);
  throw new Error('Timed out waiting for installed workspace.');
}
await mkdir(repo);
await git('init', '-b', 'main');
await writeFile(join(repo, 'series.json'), '[2, 4, 8, 10]\n');
await writeFile(
  join(repo, 'measure.cjs'),
  [
    "const values = require('./series.json');",
    'const config = JSON.parse(process.env.WORKSPACE_EXPERIMENT);',
    'const mse = values.reduce((sum, value) => sum + (value - config.parameters.prediction) ** 2, 0) / values.length;',
    "console.log('WORKSPACE_METRIC ' + JSON.stringify({name:'mse', unit:'', step:1, value:mse}));",
    "console.log('Evaluated ' + values.length + ' observations with seed ' + config.seed);",
  ].join('\n'),
);
await git('add', '.');
await git(
  '-c',
  'user.name=Workspace verification',
  '-c',
  'user.email=test@localhost',
  'commit',
  '-m',
  'Add measurement',
);
const commit = await git('rev-parse', 'HEAD');
try {
  const wrapper = windows
    ? await exec('cmd.exe', ['/d', '/c', 'ai-agent-workspace.cmd', '--version'], {
        cwd: installed,
        env,
      })
    : await exec(join(installed, 'ai-agent-workspace'), ['--version'], { cwd: sandbox, env });
  assert.equal(wrapper.stdout.trim(), manifest.version);
  await connect();
  const web = await fetch(address);
  assert.equal(web.status, 200);
  assert.match(await web.text(), /AI Agent Workspace/);
  assert.equal(await command('start', '--no-browser'), address);
  assert.equal(await command('status'), address);
  const project = await api<Project>('projects', { name: 'Personal metrics', repoPath: repo });
  const trial = await api<Trial>('projects/' + project.id + '/trials', {
    title: 'Constant prediction error',
    argv: ['node', 'measure.cjs'],
    experiment: {
      group: 'Regression',
      dataset: 'series',
      datasetVersion: '1',
      seed: 42,
      parameters: { prediction: 6 },
    },
    allocation: {},
  });
  assert.equal(trial.commit, commit);
  const attempt = await api<TrialAttempt>('trials/' + trial.id + '/attempts', {
    confirmed: true,
    requestKey: randomUUID(),
  });
  await waitFor(async () => {
    const row = (await api<Snapshot>('snapshot')).attempts.find((a) => a.id === attempt.id)!;
    if (['queued', 'starting', 'running'].includes(row.state)) return;
    assert.equal(row.state, 'completed', row.reason ?? row.state);
    assert.equal(row.exitCode, 0);
    return row;
  });
  const output = await api<AttemptOutput>('attempts/' + attempt.id + '/output');
  assert.deepEqual(output.metrics, [{ name: 'mse', unit: '', value: 10, step: 1 }]);
  assert.match(output.log, /4 observations with seed 42/);

  const providers = await api<Snapshot['providers']>('providers/refresh', {});
  assert.ok(providers.find((p) => p.id === 'codex')?.installed, 'Bundled Codex CLI must start');
  if (process.env.RUN_REAL_PROVIDER_TESTS === 'codex') {
    assert.ok(
      providers.find((p) => p.id === 'codex')?.authenticated,
      'Sign in before running paid verification',
    );
    const task = await api<Task>('projects/' + project.id + '/tasks', {
      title: 'Read-only acceptance',
      provider: 'codex',
      allocation: { timeoutSec: 120 },
      description: 'Reply with exactly WORKSPACE_OK. Do not run tools or change any files.',
    });
    const run = await api<Run>('tasks/' + task.id + '/runs', {
      requestKey: randomUUID(),
      allowReal: true,
    });
    await waitFor(async () => {
      const row = (await api<Snapshot>('snapshot')).runs.find((r) => r.id === run.id)!;
      if (['queued', 'starting', 'running'].includes(row.state)) return;
      assert.equal(row.state, 'completed', row.error ?? row.state);
      return row;
    }, 150000);
    const events = await api<StoredEvent[]>('events?limit=2000');
    assert.ok(
      events.some(
        (event) =>
          event.runId === run.id &&
          event.type === 'MessageDelta' &&
          String(event.data.text).includes('WORKSPACE_OK'),
      ),
    );
    console.log('One native Codex read-only turn completed with WORKSPACE_OK.');
  }

  await command('stop');
  assert.equal(await command('status'), 'Stopped.');
  await assert.rejects(access(join(data, 'server.lock')));
  await connect();
  const restored = await api<Snapshot>('snapshot');
  assert.equal(restored.trials.find((t) => t.id === trial.id)?.commit, commit);
  assert.equal(restored.attempts.find((a) => a.id === attempt.id)?.state, 'completed');
  assert.deepEqual(await api<AttemptOutput>('attempts/' + attempt.id + '/output'), output);

  const { pid } = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => ((await command('status')) === 'Stopped.' ? true : undefined));
  await connect();
  assert.deepEqual(await api<AttemptOutput>('attempts/' + attempt.id + '/output'), output);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(await git('rev-parse', 'HEAD'), commit);
  await command('stop');
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done));
  try {
    const bound = occupied.address();
    assert.ok(bound && typeof bound !== 'string');
    env.API_PORT = String(bound.port);
    await assert.rejects(command('start', '--no-browser'), /port is in use/);
    await assert.rejects(access(join(data, 'server.lock')));
  } finally {
    await new Promise<void>((done) => occupied.close(() => done()));
  }
  env.API_PORT = '0';
  await connect();
  console.log(
    'Installed ' +
      manifest.version +
      ' · original commit retained · 4 observations · MSE 10 · results survived stop and process termination · occupied port recovered.',
  );
} finally {
  await command('stop');
}

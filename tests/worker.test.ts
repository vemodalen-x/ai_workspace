import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture, key, settle } from './helpers.ts';
import { jsonProcess } from '../packages/agent-adapters/process.ts';
import { git } from '../packages/git-manager/index.ts';

test('worker executes actual worktree fixture and deduplicates a completed run', async () => {
  const { svc, repo, root } = await fixture();
  await svc.shutdown();
  const sessionId = randomUUID(),
    runId = randomUUID();
  const request = {
    op: 'run',
    provider: 'mock',
    sessionId,
    runId,
    repoPath: repo,
    baseCommit: await git(repo, ['rev-parse', 'HEAD']),
    prompt: 'Remote protocol fixture',
  };
  const worker = resolve('apps/worker/src/index.ts'),
    env = { ...process.env, WORKER_REPO_ROOT: root, WORKER_DATA_DIR: join(root, 'worker') };
  async function execute() {
    const lines: Record<string, unknown>[] = [];
    await jsonProcess({
      command: process.execPath,
      args: ['--import', 'tsx', worker],
      env,
      input: JSON.stringify(request) + '\n',
      keepStdinOpen: true,
      signal: AbortSignal.timeout(10000),
      onLine: (l) => lines.push(l as Record<string, unknown>),
    });
    return lines;
  }
  const lines = await execute();
  const complete = lines.find((l) => l.kind === 'complete');
  assert.ok(complete);
  assert.match(String(complete.diff), /agent-output/);
  const replay = await execute();
  assert.equal(replay.find((l) => l.kind === 'complete')?.replayed, true);
  assert.equal(
    replay.some((l) => l.kind === 'event'),
    false,
  );
  const record = JSON.parse(await readFile(join(root, 'worker', 'runs', `${runId}.json`), 'utf8'));
  assert.equal(record.state, 'completed');
  assert.equal(record.workspace.sessionId, sessionId);
});

test('worker denies repository traversal and local runner rejects malformed JSON', async () => {
  const { svc, repo, root } = await fixture();
  await svc.shutdown();
  const lines: Record<string, unknown>[] = [];
  await assert.rejects(
    jsonProcess({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('apps/worker/src/index.ts')],
      env: {
        ...process.env,
        WORKER_REPO_ROOT: join(root, 'data'),
        WORKER_DATA_DIR: join(root, 'worker'),
      },
      input:
        JSON.stringify({
          op: 'run',
          provider: 'mock',
          sessionId: randomUUID(),
          runId: randomUUID(),
          repoPath: repo,
          baseCommit: await git(repo, ['rev-parse', 'HEAD']),
          prompt: 'Denied',
        }) + '\n',
      keepStdinOpen: true,
      signal: AbortSignal.timeout(10000),
      onLine: (l) => lines.push(l as Record<string, unknown>),
    }),
  );
  assert.match(String(lines.find((l) => l.kind === 'error')?.error), /outside/);
  await assert.rejects(
    jsonProcess({
      command: process.execPath,
      args: ['-e', 'console.log("not-json")'],
      input: '',
      signal: AbortSignal.timeout(3000),
      onLine: () => {},
    }),
    /JSON|Unexpected/,
  );
});

test('explicit validation argv runs real commands; nonzero result fails the run', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, {
      title: 'Validate output',
      validationCommand: [process.execPath, '-e', 'console.log("VALIDATION_OK"); process.exit(0)'],
    });
    assert.throws(() => svc.enqueue(task.id, { requestKey: key() }), /validation command/);
    let run = svc.enqueue(task.id, { requestKey: key(), allowValidation: true });
    await settle(svc, [run.id]);
    assert.equal(svc.store.get('runs', run.id).state, 'completed');
    assert.ok(svc.store.events().some((e) => String(e.data.text).includes('VALIDATION_OK')));
    svc.saveTask(
      project.id,
      { ...task, validationCommand: [process.execPath, '-e', 'process.exit(7)'] },
      task.id,
    );
    run = svc.enqueue(task.id, { requestKey: key(), allowValidation: true });
    await settle(svc, [run.id]);
    assert.equal(svc.store.get('runs', run.id).state, 'failed');
    assert.match(svc.store.get('runs', run.id).error!, /code 7/);
    assert.equal(svc.store.all('reservations').length, 0);
  } finally {
    await svc.shutdown();
  }
});

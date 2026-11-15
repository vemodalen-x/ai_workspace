import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, key, settle } from './helpers.ts';
import { git } from '../packages/git-manager/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { activeStates } from '../packages/shared/index.ts';
const spec = {
  title: 'Seeded evaluation',
  experiment: {
    group: 'loss',
    dataset: 'fixture',
    datasetVersion: '1',
    seed: 19,
    parameters: { lr: 0.1 },
  },
  allocation: {},
};

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await wait(50);
  assert.ok(check(), 'timed out waiting for attempt');
}

test('a saved trial can run after its original commit loses its branch and reflog', async () => {
  const { svc, project, repo } = await fixture();
  try {
    await git(repo, ['switch', '--detach']);
    await git(repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=test@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Temporary experiment',
    ]);
    const trial = await svc.trials.create(project.id, {
      ...spec,
      argv: [process.execPath, '--version'],
    });
    await git(repo, ['switch', 'main']);
    // Only the throwaway repository from fixture() is pruned.
    await git(repo, ['reflog', 'expire', '--expire=now', '--all']);
    await git(repo, ['-c', 'gc.cruftPacks=false', 'gc', '--prune=now']);
    const attempt = svc.trials.enqueue(trial.id, key());
    await svc.tick();
    await until(() => !activeStates.includes(svc.store.get('attempts', attempt.id).state));
    const finished = svc.store.get('attempts', attempt.id);
    assert.equal(
      finished.state,
      'completed',
      finished.reason ?? 'Trial did not finish successfully',
    );
    assert.equal(await git(finished.workspace!, ['rev-parse', 'HEAD']), trial.commit);
  } finally {
    await svc.shutdown();
  }
});

test('a failed trial save leaves the repository refs unchanged', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const refs = await git(repo, ['show-ref']);
    svc.store.db.exec(
      "CREATE TEMP TRIGGER reject_trial BEFORE INSERT ON trials BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await assert.rejects(
      svc.trials.create(project.id, { ...spec, argv: [process.execPath, '--version'] }),
      /injected failure/,
    );
    assert.equal(await git(repo, ['show-ref']), refs);
    assert.equal(svc.store.all('trials').length, 0);
  } finally {
    await svc.shutdown();
  }
});

test('saving pins HEAD; confirmed attempts replay idempotently, retain failed metrics and retry in fresh worktrees', async () => {
  const { svc, project, repo, data } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  let attemptId: string;
  try {
    const cmd = [
      "const fs=require('node:fs'); if(fs.existsSync('attempt.txt')) process.exit(88); fs.writeFileSync('attempt.txt','ok');",
      "console.log(JSON.parse(process.env.WORKSPACE_EXPERIMENT).seed, fs.readFileSync('README.md','utf8').trim());",
      "console.error('diagnostic'); console.error('WORKSPACE_METRIC '+JSON.stringify({name:'stderr',unit:'',step:0,value:1}));",
      "for(const step of [3,0,3]) console.log('WORKSPACE_METRIC '+JSON.stringify({name:'loss',unit:'',step,value:step/10}));",
      "console.log('WORKSPACE_METRIC bad'); process.exitCode=7",
    ].join(' ');
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/trials`,
      headers,
      payload: { ...spec, argv: [process.execPath, '-e', cmd] },
    });
    assert.equal(created.statusCode, 200, created.body);
    const trial = created.json();
    assert.equal(trial.commit, await git(repo, ['rev-parse', 'HEAD']));
    assert.equal(svc.snapshot().attempts.length, 0);
    await writeFile(join(repo, 'README.md'), 'advanced');
    await git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-am',
      'Advance input',
    ]);
    const start = { method: 'POST' as const, url: `/api/trials/${trial.id}/attempts`, headers };
    assert.equal((await app.inject({ ...start, payload: { requestKey: key() } })).statusCode, 400);
    const payload = { requestKey: key(), confirmed: true };
    const first = (await app.inject({ ...start, payload })).json();
    attemptId = first.id;
    assert.equal((await app.inject({ ...start, payload })).json().id, first.id);
    assert.equal(
      (await app.inject({ ...start, payload: { ...payload, requestKey: key() } })).statusCode,
      409,
    );
    await svc.tick();
    await until(() => svc.store.get('attempts', first.id).state === 'failed');
    const failed = svc.store.get('attempts', first.id);
    assert.equal(failed.exitCode, 7);
    assert.equal(await git(failed.workspace!, ['rev-parse', 'HEAD']), trial.commit);
    const output = svc.trials.output(first.id);
    assert.match(output.log, /19 # Fixture/);
    assert.match(output.log, /diagnostic/);
    assert.equal(output.ignored, 1);
    assert.deepEqual(
      output.metrics.map((m) => [m.name, m.step, m.value]),
      [
        ['loss', 0, 0],
        ['loss', 3, 0.3],
      ],
    );
    const retry = svc.trials.enqueue(trial.id, key());
    await svc.tick();
    await until(() => svc.store.get('attempts', retry.id).state === 'failed');
    const second = svc.store.get('attempts', retry.id);
    assert.notEqual(failed.workspace, second.workspace);
    assert.equal(second.exitCode, 7);
    assert.deepEqual(svc.trials.output(second.id), output);
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'advanced');
    assert.equal(svc.snapshot().runs.length, 0);
    assert.equal(svc.store.all('reservations').length, 0);
  } finally {
    await app.close();
    await svc.shutdown();
  }
  const reopened = new Orchestrator(data);
  try {
    assert.equal(reopened.trials.output(attemptId).metrics.length, 2);
  } finally {
    await reopened.shutdown();
  }
});

test('command attempts and agents share slots and reservations; cancellation unblocks the waiting queue', async () => {
  const { svc, project } = await fixture();
  try {
    svc.updateProject(project.id, { concurrency: 1 });
    const t = await svc.trials.create(project.id, {
      ...spec,
      argv: [process.execPath, '-e', 'setInterval(()=>{},2000)'],
    });
    const a = svc.trials.enqueue(t.id, key());
    await svc.tick();
    await until(() => Boolean(svc.store.get('attempts', a.id).pid));
    const task = svc.saveTask(project.id, { title: 'Agent' }),
      run = svc.enqueue(task.id, { requestKey: key() });
    await svc.tick();
    assert.equal(svc.store.get('runs', run.id).state, 'queued');
    assert.equal(svc.store.all('reservations')[0].id, a.id);
    assert.throws(() => svc.updateProject(project.id, { archived: true }), /active/);
    svc.trials.cancel(a.id);
    await until(() => svc.store.get('attempts', a.id).state === 'cancelled');
    const retry = svc.trials.enqueue(t.id, key());
    await svc.tick();
    assert.equal(svc.store.get('attempts', retry.id).reason, 'Waiting for a project slot');
    svc.trials.cancel(retry.id);
    assert.equal((await settle(svc, [run.id]))[0].state, 'completed');
    assert.ok(!svc.store.all('attempts').some((v) => activeStates.includes(v.state)));
  } finally {
    await svc.shutdown();
  }
});

test('restart quarantines uncertain attempts until explicitly reconciled', async () => {
  const { svc, project, data } = await fixture();
  const t = await svc.trials.create(project.id, { ...spec, argv: [process.execPath, '--version'] });
  const a = svc.trials.enqueue(t.id, key());
  svc.store.put('attempts', { ...a, state: 'starting' });
  svc.store.put('reservations', {
    id: a.id,
    runId: a.id,
    nodeId: 'local',
    cpu: 1,
    ramMb: 512,
    gpu: null,
    vramMb: 0,
    quarantined: false,
  });
  await svc.shutdown();
  const restored = new Orchestrator(data);
  try {
    assert.equal(restored.store.get('attempts', a.id).state, 'orphaned');
    assert.equal(restored.store.get('reservations', a.id).quarantined, true);
    assert.throws(() => restored.trials.enqueue(t.id, key()), /active/);
    restored.trials.reconcile(a.id);
    const next = restored.trials.enqueue(t.id, key());
    await restored.tick();
    await until(() => restored.store.get('attempts', next.id).state === 'completed');
    assert.match(restored.trials.output(next.id).log, /v\d+/);
  } finally {
    await restored.shutdown();
  }
});

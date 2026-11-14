import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, key, settle } from './helpers.ts';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { git } from '../packages/git-manager/index.ts';
import { MetricOutput } from '../packages/orchestration/metric-output.ts';
import { reportedMetrics } from '../packages/shared/experiment-results.ts';

test('preview refuses a clean external commit after successful run verification', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'External commit' });
    const r = svc.enqueue(task.id, { requestKey: key() });
    await settle(svc, [r.id]);
    const w = svc.store.get('workspaces', r.sessionId);
    await writeFile(join(w.path, 'extra.txt'), 'external');
    await git(w.path, ['add', 'extra.txt']);
    await git(w.path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-m',
      'external',
    ]);
    await assert.rejects(svc.previewMerge(r.sessionId), /differs from the completed run/);
  } finally {
    await svc.shutdown();
  }
});

test('interrupted merge reconciles the exact target ref after restart and records one event', async () => {
  const { svc, project, repo, data } = await fixture();
  const task = svc.saveTask(project.id, { title: 'Recover merge' });
  const r = svc.enqueue(task.id, { requestKey: key() });
  await settle(svc, [r.id]);
  const a = await svc.previewMerge(r.sessionId);
  // Simulate storage failure immediately after the Git subprocess succeeded.
  svc.store.db.exec(
    "CREATE TRIGGER fail_merge_record BEFORE INSERT ON events WHEN NEW.type='GitMerged' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  await assert.rejects(svc.decideApproval(a.id, true), /injected/);
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), a.previewCommit);
  assert.equal(svc.store.get('approvals', a.id).state, 'applying');
  svc.store.db.exec('DROP TRIGGER fail_merge_record');
  await svc.shutdown();
  const restored = new Orchestrator(data);
  try {
    await restored.recoverMerges();
    await restored.recoverMerges();
    assert.equal(restored.store.get('approvals', a.id).state, 'approved');
    assert.equal(restored.store.events().filter((e) => e.type === 'GitMerged').length, 1);
  } finally {
    await restored.shutdown();
  }
});

test('recovery before Git mutation requests fresh approval and leaves dirty files intact', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'Interrupted before Git' });
    const r = svc.enqueue(task.id, { requestKey: key() });
    await settle(svc, [r.id]);
    const a = await svc.previewMerge(r.sessionId);
    svc.store.put('approvals', { ...a, state: 'applying' });
    await writeFile(join(repo, 'untracked.txt'), 'user file');
    await svc.recoverMerges();
    assert.equal(svc.store.get('approvals', a.id).state, 'pending');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), a.target);
    assert.match(await git(repo, ['status', '--porcelain']), /untracked.txt/);
    assert.equal(
      svc.store.events().some((e) => e.type === 'GitMerged'),
      false,
    );
  } finally {
    await svc.shutdown();
  }
});

test('metric protocol handles split lines, malformed data, bounds and late steps', () => {
  const c = new MetricOutput();
  for (const chunk of [
    'WORKSPACE_MET',
    'RIC {"name":"mIoU","value":0.72,"unit":"ratio","step":8}\nWORKSPACE_METRIC bad\n',
    'WORKSPACE_METRIC ' + 'x'.repeat(4096) + '\n',
    'WORKSPACE_METRIC {"name":"mIoU","value":0.1,"unit":"ratio","step":2}',
  ])
    c.push(Buffer.from(chunk));
  assert.deepEqual(c.finish(), [{ name: 'mIoU', value: 0.72, unit: 'ratio', step: 8 }]);
  assert.equal(c.ignored, 2);
});
test('local experiment comparison reads only validated commit-bound stdout metrics', async () => {
  const { svc, project } = await fixture();
  try {
    const script =
      'console.log("WORKSPACE_METRIC "+JSON.stringify({name:"accuracy",value:[1,1,0,1].reduce((a,b)=>a+b)/4,unit:"ratio",step:1}));console.error("WORKSPACE_METRIC "+JSON.stringify({name:"untrusted",value:1,unit:"",step:0}))';
    const task = svc.saveTask(project.id, {
      title: 'CPU evaluation',
      experiment: { group: 'regression' },
      validationCommand: [process.execPath, '-e', script],
    });
    const r = svc.enqueue(task.id, { requestKey: key(), allowValidation: true });
    const [done] = await settle(svc, [r.id]);
    const artifacts = svc.store.all('artifacts');
    assert.deepEqual(reportedMetrics(done, artifacts), [
      { name: 'accuracy', value: 0.75, unit: 'ratio', step: 1 },
    ]);
    assert.deepEqual(reportedMetrics({ ...done, resultCommit: 'wrong' }, artifacts), []);
    assert.deepEqual(reportedMetrics({ ...done, state: 'failed' }, artifacts), []);
  } finally {
    await svc.shutdown();
  }
});

test('experiment retains its observed device peak after raw samples roll off', async () => {
  const { svc, project } = await fixture();
  try {
    const m = {
      at: new Date().toISOString(),
      cpuPercent: 25,
      cores: 4,
      ramTotalMb: 2048,
      ramUsedMb: 256,
      ramFreeMb: 1792,
      disk: null,
      network: null,
      processes: [],
      gpus: [{ id: 'GPU-example', name: 'Fixture', usedMb: 730, totalMb: 1024, utilization: 77 }],
    };
    svc.metrics.local = m;
    const t = svc.saveTask(project.id, {
      title: 'Retained hardware summary',
      experiment: { group: 'hardware' },
      allocation: { gpu: 'GPU-example', vramMb: 10 },
    });
    const r = svc.enqueue(t.id, { requestKey: key() });
    await svc.tick();
    const active = svc.store.get('runs', r.id);
    assert.ok(active.startedAt && active.manifest);
    svc.telemetry.record('local', m);
    const [done] = await settle(svc, [r.id]);
    assert.equal(done.telemetryAtFinish?.sampleCount, 1);
    assert.equal(done.telemetryAtFinish?.maxGpuMemoryMiB, 730);
    svc.store.db.exec('DELETE FROM telemetry');
    const { createApp } = await import('../apps/server/src/app.ts');
    const { app, token } = await createApp(svc, { serveWeb: false });
    try {
      const response = await app.inject({
        url: `/api/runs/${r.id}/telemetry`,
        headers: { host: 'localhost', authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().window.maxGpuMemoryMiB, 730);
    } finally {
      await app.close();
    }
  } finally {
    await svc.shutdown();
  }
});

test('recovery recognizes an applied preview after the target advances and supersedes unrelated intents', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const t = svc.saveTask(project.id, { title: 'Advanced ref' }),
      r = svc.enqueue(t.id, { requestKey: key() });
    await settle(svc, [r.id]);
    const a = await svc.previewMerge(r.sessionId);
    svc.store.put('approvals', { ...a, state: 'applying' });
    await git(repo, ['merge', '--ff-only', a.previewCommit]);
    const other = await svc.previewMerge(r.sessionId);
    svc.store.put('approvals', { ...other, state: 'applying' });
    await git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'user follow-up',
    ]);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    await svc.recoverMerges();
    assert.equal(svc.store.get('approvals', a.id).state, 'approved');
    assert.equal(svc.store.get('approvals', other.id).state, 'superseded');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), head);
  } finally {
    await svc.shutdown();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fixture, key, settle } from './helpers.ts';
import { assertDag, assertTree, type StoredEvent } from '../packages/shared/index.ts';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { reserve } from '../packages/resource-manager/index.ts';
import { git, within } from '../packages/git-manager/index.ts';

test('DAG validation rejects cycles, missing dependencies; tree is independent', () => {
  assert.throws(
    () =>
      assertDag([
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['a'] },
      ]),
    /cycle/,
  );
  assert.throws(() => assertDag([{ id: 'a', dependencies: ['missing'] }]), /belong/);
  assert.throws(
    () =>
      assertTree([
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ]),
    /cycle/,
  );
  assert.doesNotThrow(() =>
    assertDag([
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['a', 'b'] },
    ]),
  );
  assert.equal(within('/managed', '/managed/../user'), false);
  assert.equal(within('/managed', '/managed'), false);
});

test('parallel A/B isolation, dependent C integration, exact merge approval, persistent history', async () => {
  const { svc, project, repo, data } = await fixture();
  const a = svc.saveTask(project.id, {
      title: 'Task A: Backend API',
      description: 'Create backend fixture',
    }),
    b = svc.saveTask(project.id, {
      title: 'Task B: Frontend UI',
      description: 'Create frontend fixture',
    });
  const c = svc.saveTask(project.id, {
    title: 'Task C: Integration',
    description: '[validate]',
    dependencies: [a.id, b.id],
    integration: true,
  });
  const ra = svc.enqueue(a.id, { requestKey: key() }),
    rb = svc.enqueue(b.id, { requestKey: key() }),
    rc = svc.enqueue(c.id, { requestKey: key() });
  await svc.tick();
  assert.equal(svc.running.size, 2);
  assert.equal(svc.store.get('tasks', c.id).state, 'blocked');
  const runs = await settle(svc, [ra.id, rb.id, rc.id]);
  assert.deepEqual(
    runs.map((r) => r.state),
    ['completed', 'completed', 'completed'],
  );
  const wa = svc.store.get('workspaces', ra.sessionId),
    wb = svc.store.get('workspaces', rb.sessionId),
    wc = svc.store.get('workspaces', rc.sessionId);
  assert.notEqual(wa.path, wb.path);
  assert.notEqual(wa.branch, wb.branch);
  assert.equal(wc.integrationCommits.length, 2);
  await assert.rejects(access(join(repo, 'agent-output')));
  await assert.rejects(access(join(wa.path, 'agent-output', `${rb.sessionId}.json`)));
  const report = JSON.parse(await readFile(join(wc.path, 'validation-report.json'), 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.checked.length, 2);
  const approval = await svc.previewMerge(rc.sessionId);
  assert.equal(approval.state, 'pending');
  await assert.rejects(access(join(repo, 'validation-report.json')));
  await svc.decideApproval(approval.id, true);
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), approval.previewCommit);
  assert.equal(
    JSON.parse(await readFile(join(repo, 'validation-report.json'), 'utf8')).passed,
    true,
  );
  const count = svc.store.events().length;
  await svc.shutdown();
  const restored = new Orchestrator(data);
  assert.equal(restored.store.events().length, count);
  assert.equal(restored.store.get('runs', ra.id).state, 'completed');
  await restored.shutdown();
});

test('duplicate request and event are idempotent; session follow-up creates another run', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'One task' }),
      requestKey = key();
    const r = svc.enqueue(task.id, { requestKey });
    assert.equal(svc.enqueue(task.id, { requestKey }).id, r.id);
    assert.throws(() => svc.enqueue(task.id, { requestKey: key() }), /active/);
    await settle(svc, [r.id]);
    svc.emit({ type: 'MessageDelta', data: { text: 'once' }, key: 'same' }, r);
    svc.emit({ type: 'MessageDelta', data: { text: 'once' }, key: 'same' }, r);
    assert.equal(svc.store.events().filter((e) => e.data.text === 'once').length, 1);
    const next = svc.enqueue(task.id, {
      sessionId: r.sessionId,
      requestKey: key(),
      prompt: 'Follow-up',
    });
    await settle(svc, [next.id]);
    assert.equal(svc.store.all('sessions').length, 1);
    assert.equal(svc.store.all('runs').length, 2);
    assert.equal(svc.store.get('runs', next.id).state, 'completed');
  } finally {
    await svc.shutdown();
  }
});

test('failed agent releases resources; dependency stays blocked; explicit retry succeeds', async () => {
  const { svc, project } = await fixture();
  try {
    const t = svc.saveTask(project.id, { title: 'Fails', description: '[fail]' }),
      dep = svc.saveTask(project.id, { title: 'Dependent', dependencies: [t.id] });
    const r = svc.enqueue(t.id, { requestKey: key() }),
      rd = svc.enqueue(dep.id, { requestKey: key() });
    await settle(svc, [r.id]);
    await svc.tick();
    assert.equal(svc.store.get('runs', r.id).state, 'failed');
    assert.equal(svc.store.get('tasks', dep.id).state, 'blocked');
    assert.equal(svc.store.all('reservations').length, 0);
    const retry = svc.enqueue(t.id, {
      requestKey: key(),
      sessionId: r.sessionId,
      prompt: 'Recover',
    });
    await settle(svc, [retry.id, rd.id]);
    assert.equal(svc.store.get('runs', rd.id).state, 'completed');
  } finally {
    await svc.shutdown();
  }
});

test('cancel, interrupt and enforced timeout are distinct, freeing allocations', async () => {
  const { svc, project } = await fixture();
  try {
    const t = svc.saveTask(project.id, {
      title: 'Slow',
      description: '[slow]',
      allocation: { timeoutSec: 1 },
    });
    let r = svc.enqueue(t.id, { requestKey: key() });
    await svc.tick();
    await wait(100);
    svc.cancel(r.id, 'paused');
    await settle(svc, [r.id]);
    assert.equal(svc.store.get('runs', r.id).state, 'paused');
    r = svc.enqueue(t.id, { requestKey: key(), sessionId: r.sessionId });
    await settle(svc, [r.id]);
    assert.equal(svc.store.get('runs', r.id).state, 'failed');
    assert.equal(svc.store.get('runs', r.id).error, 'Execution timeout');
    r = svc.enqueue(t.id, { requestKey: key() });
    svc.cancel(r.id);
    assert.equal(svc.store.get('runs', r.id).state, 'cancelled');
    assert.equal(svc.store.all('reservations').length, 0);
  } finally {
    await svc.shutdown();
  }
});

test('atomic resource reservation rejects overbooking, unavailable GPU and offline nodes', async () => {
  const { svc } = await fixture();
  try {
    const node = { ...svc.store.get('nodes', 'local'), cpu: 1, ramMb: 512 };
    const a = { cpu: 1, ramMb: 512, gpu: null, vramMb: 0, timeoutSec: 60 };
    svc.store.tx(() => reserve(svc.store, 'one', node, a));
    assert.throws(() => svc.store.tx(() => reserve(svc.store, 'two', node, a)), /Insufficient/);
    assert.equal(svc.store.all('reservations').length, 1);
    assert.throws(
      () => svc.store.tx(() => reserve(svc.store, 'offline', { ...node, status: 'offline' }, a)),
      /offline/,
    );
    svc.store.delete('reservations', 'one');
    assert.throws(
      () => svc.store.tx(() => reserve(svc.store, 'gpu', node, { ...a, gpu: '0', vramMb: 1024 })),
      /GPU unavailable/,
    );
  } finally {
    await svc.shutdown();
  }
});

test('scheduler queues on resource shortage and SSH offline without launching', async () => {
  const { svc, project } = await fixture();
  try {
    svc.store.put('nodes', { ...svc.store.get('nodes', 'local'), cpu: 1 });
    const t = svc.saveTask(project.id, { title: 'Too large', allocation: { cpu: 2 } });
    const r = svc.enqueue(t.id, { requestKey: key() });
    await svc.tick();
    assert.equal(svc.store.get('runs', r.id).state, 'queued');
    assert.match(svc.store.get('tasks', t.id).error!, /Insufficient/);
    const n = await svc.addNode({
      name: 'Offline SSH',
      sshAlias: 'missing-test-node',
      workerPath: '/srv/worker.js',
      cpu: 4,
      ramMb: 4096,
    });
    const remote = svc.saveTask(project.id, {
      title: 'Remote',
      nodeId: n.id,
      remoteRepoPath: '/srv/repo',
    });
    const rr = svc.enqueue(remote.id, { requestKey: key() });
    await svc.tick();
    assert.equal(svc.store.get('runs', rr.id).state, 'queued');
    assert.match(svc.store.get('tasks', remote.id).error!, /offline/);
    assert.equal(svc.running.size, 0);
  } finally {
    await svc.shutdown();
  }
});

test('unclean startup quarantines allocation; no automatic duplicate execution', async () => {
  const { svc, project, data } = await fixture();
  const task = svc.saveTask(project.id, { title: 'Interrupted' }),
    r = svc.enqueue(task.id, { requestKey: key() });
  svc.store.put('runs', { ...r, state: 'running' });
  svc.store.put('reservations', {
    id: r.id,
    runId: r.id,
    nodeId: 'local',
    cpu: 1,
    ramMb: 512,
    gpu: null,
    vramMb: 0,
    quarantined: false,
  });
  svc.store.close();
  const restored = new Orchestrator(data);
  try {
    assert.equal(restored.store.get('runs', r.id).state, 'orphaned');
    assert.equal(restored.store.get('reservations', r.id).quarantined, true);
    await restored.tick();
    assert.equal(restored.running.size, 0);
    assert.throws(() => restored.enqueue(task.id, { requestKey: key() }), /active/);
    assert.throws(() => restored.reconcile(r.id, false), /confirmation/);
    restored.reconcile(r.id, true);
    assert.equal(restored.store.all('reservations').length, 0);
    assert.equal(restored.store.get('runs', r.id).state, 'failed');
  } finally {
    await restored.shutdown();
  }
});

test('worktree cleanup refuses dirty state and preserves branch and user repository', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const t = svc.saveTask(project.id, { title: 'Cleanup' }),
      r = svc.enqueue(t.id, { requestKey: key() });
    await settle(svc, [r.id]);
    const w = svc.store.get('workspaces', r.sessionId);
    await writeFile(join(w.path, 'uncommitted.txt'), 'keep me');
    await assert.rejects(svc.cleanup(r.sessionId), /uncommitted/);
    await access(join(w.path, 'uncommitted.txt'));
    await svc.git.snapshot(repo, w, 'Keep user edit');
    await svc.cleanup(r.sessionId);
    await assert.rejects(access(w.path));
    await access(repo);
    assert.equal(
      await git(repo, ['rev-parse', w.branch]),
      await git(repo, ['rev-parse', w.branch]),
    );
    assert.equal(svc.store.get('sessions', r.sessionId).closed, true);
    assert.throws(() => svc.enqueue(t.id, { sessionId: r.sessionId, requestKey: key() }), /closed/);
  } finally {
    await svc.shutdown();
  }
});

test('merge conflicts and stale approvals do not change target HEAD', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const a = svc.saveTask(project.id, { title: 'A', description: '[conflict]' }),
      b = svc.saveTask(project.id, { title: 'B', description: '[conflict]' });
    const ra = svc.enqueue(a.id, { requestKey: key() }),
      rb = svc.enqueue(b.id, { requestKey: key() });
    await settle(svc, [ra.id, rb.id]);
    const aa = await svc.previewMerge(ra.sessionId),
      ab = await svc.previewMerge(rb.sessionId);
    await svc.decideApproval(aa.id, true);
    const before = await git(repo, ['rev-parse', 'HEAD']);
    await assert.rejects(svc.decideApproval(ab.id, true), /Target changed/);
    await assert.rejects(svc.previewMerge(rb.sessionId));
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), before);
    await writeFile(join(repo, 'user-change.txt'), 'keep');
    await assert.rejects(svc.previewMerge(ra.sessionId), /uncommitted/);
    assert.equal(await readFile(join(repo, 'user-change.txt'), 'utf8'), 'keep');
  } finally {
    await svc.shutdown();
  }
});

test('schema validation rejects cyclic moves/edges and changes during queued execution', async () => {
  const { svc, project } = await fixture();
  try {
    const a = svc.saveTask(project.id, { title: 'Parent' }),
      b = svc.saveTask(project.id, { title: 'Child', parentId: a.id });
    assert.throws(() => svc.saveTask(project.id, { ...a, parentId: b.id }, a.id), /cycle/);
    const c = svc.saveTask(project.id, { title: 'Depends', dependencies: [a.id] });
    assert.throws(() => svc.saveTask(project.id, { ...a, dependencies: [c.id] }, a.id), /cycle/);
    assert.throws(
      () => svc.saveTask(project.id, { title: 'Bad', dependencies: [randomUUID()] }),
      /belong/,
    );
    svc.enqueue(a.id, { requestKey: key() });
    assert.throws(() => svc.saveTask(project.id, { ...a, title: 'Changed' }, a.id), /active/);
  } finally {
    await svc.shutdown();
  }
});

test('SDK cancellation releases capacity before dispatch and quarantines an interrupted adapter', async () => {
  const { svc, project } = await fixture();
  try {
    // Inject the deterministic adapter; this does not call Codex or consume quota.
    svc.adapters = { ...svc.adapters, codex: svc.adapters.mock };
    svc.providers = [
      {
        id: 'codex',
        name: 'Contract fixture',
        installed: true,
        authenticated: true,
        version: 'test',
        detail: 'test only',
        capabilities: svc.adapters.mock.getCapabilities(),
      },
    ];
    for (const phase of ['workspace', 'adapter'] as const) {
      const t = svc.saveTask(project.id, {
        title: `Cancel at ${phase} startup`,
        provider: 'codex',
      });
      const r = svc.enqueue(t.id, { requestKey: key(), allowReal: true });
      const starts: string[] = [];
      const onStart = (event: StoredEvent) => {
        if (event.runId !== r.id || event.type !== 'SessionStarted') return;
        const stage = typeof event.data.providerSessionId === 'string' ? 'adapter' : 'workspace';
        starts.push(stage);
        if (stage === phase) svc.cancel(r.id);
      };
      svc.store.bus.on('event', onStart);
      try {
        await settle(svc, [r.id]);
      } finally {
        svc.store.bus.off('event', onStart);
      }
      if (phase === 'workspace') {
        assert.deepEqual(starts, ['workspace']);
        assert.equal(svc.store.get('runs', r.id).state, 'cancelled');
      } else {
        assert.deepEqual(starts, ['workspace', 'adapter']);
        assert.equal(svc.store.get('runs', r.id).state, 'orphaned');
        assert.equal(svc.store.get('reservations', r.id).quarantined, true);
        svc.reconcile(r.id, true);
      }
      assert.equal(svc.store.all('reservations').length, 0);
    }
  } finally {
    await svc.shutdown();
  }
});

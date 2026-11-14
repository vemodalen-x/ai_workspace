import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../packages/orchestration/store.ts';
import { assertTransition } from '../packages/orchestration/lifecycle.ts';
import { freshness, evidence } from '../packages/shared/evidence.ts';
import { fixture, key, settle } from './helpers.ts';

test('transaction rolls back rows and events, publishes only committed events and isolates subscribers', () => {
  const store = new Store(':memory:');
  const seen: number[] = [];
  store.bus.on('event', () => {
    throw new Error('Disconnected client');
  });
  store.bus.on('event', (e) => seen.push(e.seq));
  try {
    assert.throws(
      () =>
        store.tx(() => {
          store.event({ type: 'Log', data: { text: 'rollback' }, key: 'same' });
          assert.equal(seen.length, 0);
          throw new Error('crash');
        }),
      /crash/,
    );
    assert.equal(store.events().length, 0);
    store.tx(() => {
      store.event({ type: 'Log', data: { text: 'committed' }, key: 'same' });
      assert.equal(seen.length, 0);
    });
    assert.equal(store.events().length, 1);
    assert.equal(seen.length, 1);
    store.event({ type: 'Log', data: { text: 'duplicate' }, key: 'same' });
    assert.equal(seen.length, 1);
    assert.throws(() => store.tx(() => store.tx(() => {})), /Nested/);
    assert.equal(store.events().length, 1);
  } finally {
    store.close();
  }
});

test('failed event insert atomically rolls back enqueue and allows same idempotency key retry', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'Atomic enqueue' });
    const requestKey = key();
    svc.store.db.exec(
      "CREATE TEMP TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.type='RunQueued' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;",
    );
    assert.throws(() => svc.enqueue(task.id, { requestKey }), /injected/);
    assert.equal(svc.store.all('runs').length, 0);
    assert.equal(svc.store.all('sessions').length, 0);
    assert.equal(svc.store.get('tasks', task.id).state, 'draft');
    svc.store.db.exec('DROP TRIGGER reject_event');
    const run = svc.enqueue(task.id, { requestKey });
    await settle(svc, [run.id]);
    const done = svc.store.get('runs', run.id);
    assert.equal(done.state, 'completed');
    assert.equal(
      svc.store.events().filter((e) => e.type === 'RunQueued' && e.runId === run.id).length,
      1,
    );
    assert.throws(() => svc.finish(run.id, 'failed'), /Invalid run transition/);
    assert.equal(svc.store.get('runs', run.id).state, 'completed');
  } finally {
    await svc.shutdown();
  }
});

test('dependency rerun invalidates transitive evidence, prevents stale merge and holds downstream queue', async () => {
  const { svc, project } = await fixture();
  try {
    const a = svc.saveTask(project.id, { title: 'A' });
    const b = svc.saveTask(project.id, { title: 'B', dependencies: [a.id], integration: true });
    const c = svc.saveTask(project.id, { title: 'C', dependencies: [b.id], integration: true });
    const ra = svc.enqueue(a.id, { requestKey: key() });
    const rb = svc.enqueue(b.id, { requestKey: key() });
    const rc = svc.enqueue(c.id, { requestKey: key() });
    await settle(svc, [ra.id, rb.id, rc.id]);
    const approval = await svc.previewMerge(rc.sessionId);
    const doneB = svc.store.get('runs', rb.id),
      doneC = svc.store.get('runs', rc.id);
    assert.equal(freshness(svc.snapshot(), doneC).freshness, 'current');
    assert.equal(doneB.manifest?.dependencies[0].commit, svc.store.get('runs', ra.id).resultCommit);
    const ra2 = svc.enqueue(a.id, {
      requestKey: key(),
      sessionId: ra.sessionId,
      prompt: 'A second version',
    });
    await settle(svc, [ra2.id]);
    assert.equal(freshness(svc.snapshot(), doneB).freshness, 'stale');
    assert.equal(freshness(svc.snapshot(), doneC).freshness, 'stale');
    assert.equal(svc.store.get('runs', rc.id).state, 'completed');
    assert.equal(svc.snapshot().briefing.items.find((i) => i.taskId === c.id)?.kind, 'stale');
    await assert.rejects(svc.decideApproval(approval.id, true), /inputs changed/);
    const d = svc.saveTask(project.id, { title: 'D', dependencies: [c.id] });
    const rd = svc.enqueue(d.id, { requestKey: key() });
    await svc.tick();
    assert.equal(svc.store.get('runs', rd.id).state, 'queued');
    assert.match(svc.store.get('tasks', d.id).error!, /stale/);
    const retry = svc.enqueue(b.id, { requestKey: key(), sessionId: rb.sessionId });
    await settle(svc, [retry.id]);
    assert.match(svc.store.get('runs', retry.id).error!, /new session/);
    const newB = svc.enqueue(b.id, { requestKey: key() });
    await settle(svc, [newB.id]);
    assert.equal(svc.store.get('runs', newB.id).state, 'completed');
    assert.equal(freshness(svc.snapshot(), svc.store.get('runs', newB.id)).freshness, 'current');
  } finally {
    await svc.shutdown();
  }
});

test('integration uses immutable run commit rather than mutable workspace head metadata', async () => {
  const { svc, project } = await fixture();
  try {
    const a = svc.saveTask(project.id, { title: 'Source' });
    const ra = svc.enqueue(a.id, { requestKey: key() });
    await settle(svc, [ra.id]);
    const w = svc.store.get('workspaces', ra.sessionId);
    svc.store.put('workspaces', { ...w, headCommit: 'not-a-commit' });
    const b = svc.saveTask(project.id, {
      title: 'Integration',
      dependencies: [a.id],
      integration: true,
    });
    const rb = svc.enqueue(b.id, { requestKey: key() });
    await settle(svc, [rb.id]);
    assert.equal(svc.store.get('runs', rb.id).state, 'completed');
    assert.deepEqual(svc.store.get('workspaces', rb.sessionId).integrationCommits, [
      svc.store.get('runs', ra.id).resultCommit,
    ]);
  } finally {
    await svc.shutdown();
  }
});

test('definition and context revisions preserve history; prompt digest matches dispatched artifact', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'Versioned' });
    const run = svc.enqueue(task.id, { requestKey: key() });
    svc.updateProject(project.id, { context: 'Freeze this instruction' });
    await settle(svc, [run.id]);
    const done = svc.store.get('runs', run.id);
    assert.equal(done.manifest?.projectContext, 'Freeze this instruction');
    const brief = svc.store
      .all('artifacts')
      .find((a) => a.runId === run.id && a.kind === 'context')!;
    assert.equal(
      done.manifest?.promptDigest,
      createHash('sha256').update(brief.content).digest('hex'),
    );
    svc.saveTask(project.id, task, task.id);
    assert.equal(freshness(svc.snapshot(), done).freshness, 'current');
    svc.saveTask(project.id, { ...task, criteria: 'New acceptance criterion' }, task.id);
    assert.equal(freshness(svc.snapshot(), done).freshness, 'stale');
    assert.equal(done.manifest?.taskSpec.criteria, '');
    svc.updateProject(project.id, { context: 'Changed instruction' });
    assert.match(freshness(svc.snapshot(), done).reasons.join(' '), /working agreements/);
    assert.equal(freshness(svc.snapshot(), { ...done, manifest: undefined }).freshness, 'unknown');
  } finally {
    await svc.shutdown();
  }
});

test('verification tests frozen candidate in separate worktree and refuses tracked-code mutation', async () => {
  const { svc, project, repo } = await fixture();
  try {
    const t = svc.saveTask(project.id, {
      title: 'Mutating check',
      validationCommand: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('README.md','changed by verifier')",
      ],
    });
    const r = svc.enqueue(t.id, { requestKey: key(), allowValidation: true });
    await settle(svc, [r.id]);
    const done = svc.store.get('runs', r.id);
    assert.equal(done.state, 'failed');
    assert.match(done.error!, /modified tracked code/);
    const report = JSON.parse(
      svc.store.all('artifacts').find((a) => a.runId === r.id && a.kind === 'validation')!.content,
    );
    assert.equal(report.passed, false);
    assert.equal(report.retained, true);
    const w = svc.store.get('workspaces', r.sessionId);
    assert.notEqual(report.workspace, w.path);
    assert.equal(await readFile(join(w.path, 'README.md'), 'utf8'), '# Fixture\n');
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# Fixture\n');
    assert.equal(
      await readFile(join(report.workspace, 'README.md'), 'utf8'),
      'changed by verifier',
    );
  } finally {
    await svc.shutdown();
  }
});

test('clean passing validation removes temporary worktree and evidence requires matching commit', async () => {
  const { svc, project } = await fixture();
  try {
    const t = svc.saveTask(project.id, {
      title: 'Clean check',
      validationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    const r = svc.enqueue(t.id, { requestKey: key(), allowValidation: true });
    await settle(svc, [r.id]);
    const done = svc.store.get('runs', r.id);
    const artifact = svc.store
      .all('artifacts')
      .find((a) => a.runId === r.id && a.kind === 'validation')!;
    const report = JSON.parse(artifact.content);
    assert.equal(report.commit, done.resultCommit);
    assert.equal(report.retained, false);
    await assert.rejects(access(report.workspace));
    assert.equal(evidence(svc.snapshot(), done).command, 'passed');
    svc.store.put('artifacts', {
      ...artifact,
      content: JSON.stringify({ ...report, commit: 'wrong' }),
    });
    assert.equal(evidence(svc.snapshot(), done).command, 'not_run');
  } finally {
    await svc.shutdown();
  }
});

test('state machine rejects terminal rewrites and queued success while allowing orphan reconciliation', () => {
  assert.throws(() => assertTransition('queued', 'completed'), /Invalid/);
  assert.throws(() => assertTransition('completed', 'running'), /Invalid/);
  assert.throws(() => assertTransition('cancelled', 'completed'), /Invalid/);
  assert.doesNotThrow(() => assertTransition('running', 'orphaned'));
  assert.doesNotThrow(() => assertTransition('orphaned', 'failed'));
});

test('post-commit subscribers that write events cannot reorder an atomic batch', () => {
  const store = new Store(':memory:');
  const order: string[] = [];
  try {
    store.bus.on('event', (e) => {
      if (e.data.text === 'first') store.event({ type: 'Log', data: { text: 'third' } });
    });
    store.bus.on('event', (e) => order.push(e.data.text));
    store.tx(() => {
      store.event({ type: 'Log', data: { text: 'first' } });
      store.event({ type: 'Log', data: { text: 'second' } });
    });
    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.deepEqual(
      store.events().map((e) => e.data.text),
      order,
    );
  } finally {
    store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, key, settle } from './helpers.ts';
import { buildBriefing, evidence, executionBrief } from '../packages/shared/assistant.ts';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { createApp } from '../apps/server/src/app.ts';

test('capture is inert, prioritizes actionable drafts, separates dependency waiting and parent groups', async () => {
  const { svc, project } = await fixture();
  try {
    const draft = svc.saveTask(project.id, { title: 'Unprocessed thought' });
    const parent = svc.saveTask(project.id, { title: 'Outcome group' });
    const ready = svc.saveTask(project.id, {
      title: 'Implement API',
      parentId: parent.id,
      description: 'Add GET health',
      criteria: 'Returns 200',
      priority: 99,
    });
    const blocked = svc.saveTask(project.id, { title: 'Dependent', dependencies: [ready.id] });
    const b = svc.snapshot().briefing;
    assert.equal(b.items.find((i) => i.taskId === draft.id)?.kind, 'clarify');
    assert.equal(b.items.find((i) => i.taskId === ready.id)?.kind, 'ready');
    assert.match(b.items.find((i) => i.taskId === blocked.id)!.reason, /Implement API/);
    assert.equal(
      b.items.some((i) => i.taskId === parent.id),
      false,
    );
    assert.equal(svc.store.all('runs').length, 0);
    assert.equal(svc.store.all('sessions').length, 0);
    svc.updateProject(project.id, { archived: true });
    assert.equal(svc.snapshot().briefing.items.length, 0);
  } finally {
    await svc.shutdown();
  }
});

test('evidence stays bound to an exact run commit across continuation and approval', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, {
      title: 'Validated change',
      validationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    const first = svc.enqueue(task.id, { requestKey: key(), allowValidation: true });
    await settle(svc, [first.id]);
    const done = svc.store.get('runs', first.id);
    assert.ok(done.resultCommit);
    assert.equal(evidence(svc.snapshot(), done).command, 'passed');
    assert.equal(evidence(svc.snapshot(), done).merged, false);
    const approval = await svc.previewMerge(first.sessionId);
    assert.equal(svc.snapshot().briefing.items[0].kind, 'approve');
    await svc.decideApproval(approval.id, true);
    assert.equal(evidence(svc.snapshot(), done).merged, true);
    assert.equal(svc.snapshot().briefing.items.length, 0);
    const second = svc.enqueue(task.id, {
      requestKey: key(),
      sessionId: first.sessionId,
      prompt: 'Follow-up',
      allowValidation: true,
    });
    await settle(svc, [second.id]);
    const next = svc.store.get('runs', second.id);
    assert.notEqual(next.resultCommit, done.resultCommit);
    assert.equal(evidence(svc.snapshot(), next).merged, false);
    assert.equal(evidence(svc.snapshot(), done).merged, true);
    assert.equal(svc.snapshot().briefing.items[0].kind, 'review');
    const old = { ...done, resultCommit: undefined };
    assert.equal(evidence(svc.snapshot(), old).merged, false);
  } finally {
    await svc.shutdown();
  }
});

test('command success, no verification and malformed legacy evidence remain distinct', async () => {
  const { svc, project } = await fixture();
  try {
    const task = svc.saveTask(project.id, { title: 'Without checks' });
    const run = svc.enqueue(task.id, { requestKey: key() });
    await settle(svc, [run.id]);
    assert.equal(evidence(svc.snapshot(), run).command, 'not_run');
    assert.equal(svc.snapshot().briefing.review.unverified, 1);
    svc.store.put('artifacts', {
      id: key(),
      runId: run.id,
      kind: 'validation',
      name: 'command-validation.json',
      content: '{"passed": true}',
      createdAt: new Date().toISOString(),
    });
    assert.equal(evidence(svc.snapshot(), run).command, 'not_run');
    assert.equal(
      buildBriefing(svc.snapshot(), new Date(Date.now() + 8 * 86400000)).review.completed,
      0,
    );
  } finally {
    await svc.shutdown();
  }
});

test('brief is persisted at dispatch, includes finished dependencies, project context, and prior failure', async () => {
  const { svc, project, data } = await fixture();
  let restored: Orchestrator | undefined;
  try {
    svc.updateProject(project.id, { context: 'Use C++ for inference; Python for evaluation.' });
    const dep = svc.saveTask(project.id, { title: 'Dependency' });
    const task = svc.saveTask(project.id, {
      title: 'Target',
      description: 'Implement carefully',
      criteria: 'Deterministic results',
      dependencies: [dep.id],
    });
    const a = svc.enqueue(dep.id, { requestKey: key() });
    const b = svc.enqueue(task.id, { requestKey: key(), prompt: '[fail]' });
    await settle(svc, [a.id, b.id]);
    const artifact = svc.store
      .all('artifacts')
      .find((x) => x.runId === b.id && x.kind === 'context')!;
    assert.match(artifact.content, /Use C\+\+/);
    assert.match(artifact.content, /Deterministic results/);
    assert.ok(artifact.content.includes(svc.store.get('runs', a.id).resultCommit!));
    const c = svc.enqueue(task.id, {
      requestKey: key(),
      sessionId: b.sessionId,
      prompt: 'Fix the issue',
    });
    await settle(svc, [c.id]);
    const brief = svc.store.all('artifacts').find((x) => x.runId === c.id && x.kind === 'context')!;
    assert.match(brief.content, /Requested mock agent failure/);
    assert.equal(svc.store.get('runs', c.id).state, 'completed');
    assert.equal(svc.store.get('runs', c.id).prompt, 'Fix the issue');
    await svc.shutdown();
    restored = new Orchestrator(data);
    assert.equal(restored.store.get('artifacts', brief.id).content, brief.content);
    assert.equal(
      restored.snapshot().briefing.items.find((i) => i.taskId === task.id)?.kind,
      'review',
    );
  } finally {
    if (restored) await restored.shutdown();
    else await svc.shutdown();
  }
});

test('orphan recovery takes precedence, provider and offline node do not appear ready', async () => {
  const { svc, project } = await fixture();
  try {
    const t = svc.saveTask(project.id, { title: 'Interrupted' });
    const r = svc.enqueue(t.id, { requestKey: key() });
    svc.store.put('runs', { ...r, state: 'orphaned' });
    svc.saveTask(project.id, {
      title: 'Not logged in',
      description: 'Do work',
      criteria: 'Pass',
      provider: 'claude',
    });
    const b = svc.snapshot().briefing;
    assert.equal(b.items[0].kind, 'recover');
    assert.match(b.items[1].reason, /authentication/);
    svc.store.put('nodes', { ...svc.store.get('nodes', 'local'), status: 'offline' });
    assert.match(svc.snapshot().briefing.items[1].reason, /not online/);
  } finally {
    await svc.shutdown();
  }
});

test('assistant API enforces auth, bounded project context and persists quick capture without runs', async () => {
  const { svc, project } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (await app.inject({ url: '/api/assistant', headers: { host: 'localhost' } })).statusCode,
      401,
    );
    const update = { method: 'PATCH' as const, url: `/api/projects/${project.id}`, headers };
    assert.equal(
      (await app.inject({ ...update, payload: { context: 'x'.repeat(12001) } })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ ...update, payload: { context: 'No destructive migrations' } }))
        .statusCode,
      200,
    );
    await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      headers,
      payload: { title: 'Investigate slow inference' },
    });
    const b = (await app.inject({ url: '/api/assistant', headers })).json();
    assert.equal(b.items[0].kind, 'clarify');
    assert.equal(svc.store.all('runs').length, 0);
    const task = svc.store.all('tasks')[0];
    const r = svc.enqueue(task.id, { requestKey: key(), prompt: 'Instruction must survive' });
    const brief = executionBrief(svc.snapshot(), { ...task, description: 'x'.repeat(40000) }, r);
    assert.match(brief, /\[truncated\]/);
    assert.ok(brief.endsWith('Instruction must survive'));
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

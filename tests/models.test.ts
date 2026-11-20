import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCatalog } from '../packages/agent-adapters/models.ts';
import { createApp } from '../apps/server/src/app.ts';
import { fixture, key, settle } from './helpers.ts';
import type { AgentConfig } from '../packages/agent-adapters/index.ts';

test('model catalog exposes only listed IDs and supported efforts, with safe fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'models-test-'));
  const path = join(root, 'cache.json');
  try {
    await writeFile(
      path,
      JSON.stringify({
        models: [
          {
            slug: 'fixture-model',
            display_name: 'Fixture model',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'high' }, { effort: 'unknown' }],
            instructions: 'private',
          },
          { slug: 'hidden', visibility: 'hide' },
        ],
      }),
    );
    const catalog = await modelCatalog(path);
    assert.deepEqual(catalog.codex, [
      { id: 'fixture-model', label: 'Fixture model', efforts: ['high'] },
    ]);
    assert.equal(catalog.codexSource, 'local-cache');
    await writeFile(path, '{bad');
    assert.equal((await modelCatalog(path)).codexSource, 'unavailable');
    assert.deepEqual((await modelCatalog(join(root, 'missing'))).codex, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model API auth, run validation, session inheritance and protected deletion', async () => {
  const { svc, project } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (await app.inject({ url: '/api/models', headers: { host: 'localhost' } })).statusCode,
      401,
    );
    assert.equal((await app.inject({ url: '/api/models', headers })).statusCode, 200);
    const task = svc.saveTask(project.id, { title: 'Model fixture' });
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/runs`,
      headers,
      payload: { requestKey: key(), reasoningEffort: 'invented' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.throws(
      () => svc.enqueue(task.id, { requestKey: key(), reasoningEffort: 'high' }),
      /only for Codex/,
    );
    const first = svc.enqueue(task.id, { requestKey: key(), model: 'fixture-a' });
    await settle(svc, [first.id]);
    assert.equal(svc.store.get('sessions', first.sessionId).model, 'fixture-a');
    assert.throws(() => svc.deleteTask(task.id), /session history/);
    assert.throws(
      () =>
        svc.enqueue(task.id, { requestKey: key(), sessionId: first.sessionId, model: 'fixture-b' }),
      /new session/,
    );
    const resumed = svc.enqueue(task.id, { requestKey: key(), sessionId: first.sessionId });
    assert.equal(resumed.sessionId, first.sessionId);
    await settle(svc, [resumed.id]);
    const rerun = svc.enqueue(task.id, { requestKey: key(), model: 'fixture-b' });
    assert.notEqual(rerun.sessionId, first.sessionId);
    assert.equal(svc.store.get('sessions', rerun.sessionId).model, 'fixture-b');
    await settle(svc, [rerun.id]);
    const draft = svc.saveTask(project.id, { title: 'Disposable' });
    svc.deleteTask(draft.id);
    assert.ok(!svc.store.all('tasks').some((task) => task.id === draft.id));
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('Codex model and reasoning persist without invoking a real provider', async () => {
  const { svc, project } = await fixture();
  try {
    const captured: AgentConfig[] = [];
    svc.adapters = {
      ...svc.adapters,
      codex: {
        getCapabilities: () => svc.adapters.mock.getCapabilities(),
        run: async (config, emit) => {
          captured.push(config);
          await svc.adapters.mock.run(config, emit);
        },
      },
    };
    const task = svc.saveTask(project.id, { title: 'Codex configuration', provider: 'codex' });
    svc.providers = [
      {
        id: 'codex',
        name: 'Codex',
        version: 'fixture',
        detail: 'Fixture only',
        capabilities: svc.adapters.codex.getCapabilities(),
        installed: true,
        authenticated: true,
      },
    ];
    const run = svc.enqueue(task.id, {
      requestKey: key(),
      model: 'fixture-codex',
      reasoningEffort: 'high',
      allowReal: true,
    });
    const session = svc.store.get('sessions', run.sessionId);
    assert.equal(session.model, 'fixture-codex');
    assert.equal(session.reasoningEffort, 'high');
    await settle(svc, [run.id]);
    assert.equal(captured[0].model, 'fixture-codex');
    assert.equal(captured[0].reasoningEffort, 'high');
    assert.throws(
      () =>
        svc.enqueue(task.id, {
          requestKey: key(),
          sessionId: session.id,
          reasoningEffort: 'low',
          allowReal: true,
        }),
      /new session/,
    );
  } finally {
    await svc.shutdown();
  }
});

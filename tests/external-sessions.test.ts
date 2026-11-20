import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/orchestration/store.ts';
import { ExternalSessions } from '../packages/orchestration/external-sessions.ts';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { createApp } from '../apps/server/src/app.ts';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'attached-session-'));
  const projects = join(root, 'projects');
  const dir = join(projects, '-some-original-directory');
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const path = join(dir, `${id}.jsonl`);
  const line = (text: string) =>
    JSON.stringify({
      sessionId: id,
      type: 'user',
      cwd: '/original/location',
      timestamp: '2026-11-17T10:00:00Z',
      message: { content: text },
    }) + '\n';
  await writeFile(path, line('original question'));
  const store = new Store(join(root, 'state.db'));
  store.put('projects', {
    id: 'project',
    name: 'Camera',
    repoPath: '/different/project',
    baseBranch: 'main',
    concurrency: 1,
    archived: false,
    createdAt: new Date().toISOString(),
  });
  return {
    root,
    projects,
    dir,
    id,
    path,
    line,
    store,
    service: new ExternalSessions(store, projects),
  };
}

test('attach persists association, tails appends, ignores partial records, detaches without changing source', async () => {
  const f = await setup();
  try {
    const session = await f.service.attach('project', { providerSessionId: f.id });
    assert.equal(session.sourceCwd, '/original/location');
    assert.equal((await f.service.attach('project', { providerSessionId: f.id })).id, session.id);
    assert.equal(f.store.all('sessions').length, 0);
    assert.equal(f.store.all('runs').length, 0);
    assert.equal(f.store.all('workspaces').length, 0);
    await appendFile(f.path, f.line('new message').trimEnd());
    assert.deepEqual(
      (await f.service.output(session.id)).entries.map((e) => e.text),
      ['original question'],
    );
    await appendFile(f.path, '\n');
    assert.deepEqual(
      (await f.service.output(session.id)).entries.map((e) => e.text),
      ['original question', 'new message'],
    );
    // Re-open the database to verify associations survive a controller restart.
    const restored = new Store(join(f.root, 'state.db'));
    try {
      assert.equal(new ExternalSessions(restored, f.projects).list('project')[0].id, session.id);
    } finally {
      restored.close();
    }
    await writeFile(f.path, f.line('rotated/truncated file'));
    assert.equal((await f.service.output(session.id)).entries[0].text, 'rotated/truncated file');
    const before = await readFile(f.path, 'utf8');
    f.service.detach(session.id);
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.deepEqual(f.service.list('project'), []);
  } finally {
    f.store.close();
  }
});

test('source discovery rejects invalid, foreign, duplicate and symlinked sessions; missing files retain links', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.service.attach('project', { providerSessionId: '../../secret' }));
    await assert.rejects(
      f.service.attach('project', { providerSessionId: randomUUID() }),
      /not found/,
    );
    await writeFile(f.path, JSON.stringify({ sessionId: randomUUID(), type: 'user' }) + '\n');
    await assert.rejects(f.service.attach('project', { providerSessionId: f.id }), /No matching/);
    await writeFile(f.path, f.line('valid'));
    const session = await f.service.attach('project', { providerSessionId: f.id });
    const second = join(f.projects, 'duplicate');
    await mkdir(second);
    await writeFile(join(second, `${f.id}.jsonl`), f.line('duplicate'));
    await assert.rejects(f.service.output(session.id), /Ambiguous/);
    await rename(second, join(f.root, 'moved-duplicate'));
    await rename(f.path, join(f.root, 'outside.jsonl'));
    await assert.rejects(f.service.output(session.id), /not found/);
    assert.equal(f.service.list('project').length, 1);
    await symlink(join(f.root, 'outside.jsonl'), f.path);
    await assert.rejects(f.service.output(session.id), /symlink/);
  } finally {
    f.store.close();
  }
});

test('transcript is bounded, redacted and excludes thinking/tool payloads and other session IDs', async () => {
  const f = await setup();
  const previous = process.env.ATTACH_TEST_API_KEY;
  process.env.ATTACH_TEST_API_KEY = 'unique-private-test-value';
  try {
    const session = await f.service.attach('project', { providerSessionId: f.id });
    await writeFile(
      f.path,
      f.line('old question') +
        f.line('x'.repeat(1100000)) +
        'malformed\n' +
        JSON.stringify({
          sessionId: f.id,
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'hidden reasoning' },
              { type: 'text', text: 'unique-private-test-value' },
              { type: 'tool_use', name: 'Bash', input: { command: 'secret command' } },
              { type: 'tool_result', content: 'secret tool output' },
            ],
          },
        }) +
        '\n' +
        JSON.stringify({ sessionId: randomUUID(), type: 'user', message: { content: 'foreign' } }) +
        '\n',
    );
    const output = await f.service.output(session.id);
    assert.equal(output.truncated, true);
    assert.ok(output.skipped > 0);
    assert.equal(output.entries.length, 1);
    assert.match(output.entries[0].text, /REDACTED/);
    assert.doesNotMatch(
      JSON.stringify(output),
      /secret command|secret tool output|hidden reasoning|old question|foreign|unique-private-test-value/,
    );
    await writeFile(f.path, f.line('a'.repeat(31990) + 'unique-private-test-value'));
    const clipped = await f.service.output(session.id);
    assert.equal(clipped.truncated, true);
    assert.doesNotMatch(clipped.entries[0].text, /unique-pri/);
  } finally {
    if (previous === undefined) delete process.env.ATTACH_TEST_API_KEY;
    else process.env.ATTACH_TEST_API_KEY = previous;
    f.store.close();
  }
});

test('API requires local auth, rejects archived projects and removes only project registration with attached history', async () => {
  const f = await setup();
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.root;
  const svc = new Orchestrator(join(f.root, 'controller'));
  svc.store.put('projects', f.store.get('projects', 'project'));
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (
        await app.inject({
          url: '/api/projects/project/external-sessions',
          headers: { host: 'localhost' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/projects/project/external-sessions',
          method: 'POST',
          headers,
          payload: { providerSessionId: '../bad' },
        })
      ).statusCode,
      400,
    );
    const attached = await app.inject({
      url: '/api/projects/project/external-sessions',
      method: 'POST',
      headers,
      payload: { providerSessionId: f.id },
    });
    assert.equal(attached.statusCode, 200);
    const id = attached.json().id;
    assert.equal(
      (await app.inject({ url: `/api/external-sessions/${id}/output`, headers })).json().entries[0]
        .text,
      'original question',
    );
    assert.equal(
      (await app.inject({ url: '/api/projects/project', method: 'DELETE', headers })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `/api/external-sessions/${id}`, method: 'DELETE', headers }))
        .statusCode,
      200,
    );
    svc.store.put('projects', { ...svc.store.get('projects', 'project'), archived: true });
    assert.equal(
      (
        await app.inject({
          url: '/api/projects/project/external-sessions',
          method: 'POST',
          headers,
          payload: { providerSessionId: f.id },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
    await svc.shutdown();
    f.store.close();
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  }
});

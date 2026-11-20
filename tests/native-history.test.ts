import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  chmod,
  rm,
  appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeHistoryReader } from '../packages/orchestration/native-history.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-history-'));
  const project = join(root, 'project'),
    other = join(root, 'project-other'),
    codex = join(root, 'codex'),
    claude = join(root, 'claude');
  for (const path of [
    project,
    other,
    join(project, '.codex'),
    join(project, '.claude'),
    join(codex, 'sessions/2026/11/18'),
    join(claude, 'projects/encoded-collision'),
  ])
    await mkdir(path, { recursive: true });
  const c = join(codex, 'sessions/2026/11/18/rollout-one.jsonl'),
    a = join(claude, 'projects/encoded-collision/one.jsonl');
  await writeFile(
    c,
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-one', cwd: project } }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'npm test 中文 原文' }] },
      }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Original response' }],
        },
      }) +
      '\n',
  );
  await writeFile(
    a,
    JSON.stringify({
      type: 'user',
      sessionId: 'claude-one',
      cwd: project,
      message: { content: 'Claude 原文 --flag' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-one',
        message: {
          content: [
            { type: 'thinking', thinking: 'HIDDEN' },
            { type: 'text', text: 'Visible' },
          ],
        },
      }) +
      '\n',
  );
  await writeFile(
    join(claude, 'projects/encoded-collision/other.jsonl'),
    JSON.stringify({
      type: 'user',
      sessionId: 'other',
      cwd: other,
      message: { content: 'OTHER PROJECT SECRET' },
    }) + '\n',
  );
  await writeFile(join(project, '.codex/config.toml'), 'model="sample"\napi_key="secret-value"\n');
  await writeFile(join(project, 'AGENTS.md'), '# 原始 instructions\n');
  await writeFile(join(project, '.claude/settings.json'), '{"env":{"TOKEN":"private-value"}}');
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,title TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(
    'codex-one',
    project,
    c,
    'My Codex session',
  );
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(
    'index-only',
    project,
    join(codex, 'absent.jsonl'),
    'Missing rollout',
  );
  db.close();
  return {
    root,
    project,
    other,
    codex,
    claude,
    c,
    a,
    reader: new NativeHistoryReader({ codex, claude }),
  };
}

test('discovers both tool homes by canonical cwd, reads original messages, reports config and indexed-only history without leaking settings', async () => {
  const f = await fixture();
  try {
    const data = await f.reader.scan(f.project);
    assert.equal(data.sessions.length, 2);
    assert.deepEqual(data.sessions.map((s) => s.provider).sort(), ['claude', 'codex']);
    assert.equal(data.sessions.find((s) => s.provider === 'codex')?.title, 'My Codex session');
    assert.ok(
      data.sources.some(
        (s) => s.path.endsWith('state_5.sqlite') && s.state === 'partial' && s.skipped === 1,
      ),
    );
    assert.ok(data.configs.some((c) => c.content === '# 原始 instructions\n'));
    const serial = JSON.stringify(data);
    for (const secret of ['secret-value', 'private-value', 'OTHER PROJECT SECRET'])
      assert.ok(!serial.includes(secret));
    assert.ok(serial.includes('api_key'));
    const codex = data.sessions.find((s) => s.provider === 'codex')!;
    const output = await f.reader.output(f.project, codex.id);
    assert.deepEqual(
      output.entries.map((e) => e.text),
      ['npm test 中文 原文', 'Original response'],
    );
    const claude = data.sessions.find((s) => s.provider === 'claude')!;
    assert.deepEqual(
      (await f.reader.output(f.project, claude.id)).entries.map((e) => e.text),
      ['Claude 原文 --flag', 'Visible'],
    );
    assert.equal((await f.reader.scan(f.other)).sessions.length, 1);
    await assert.rejects(f.reader.output(f.other, codex.id), /not found/);
    assert.equal((await readFile(f.a, 'utf8')).includes('HIDDEN'), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('missing, malformed, unreadable, symlinked and changed sources fail clearly; bounded tails remain readable', async () => {
  const f = await fixture();
  try {
    const empty = new NativeHistoryReader({
      codex: join(f.root, 'absent'),
      claude: join(f.root, 'missing'),
    });
    assert.ok((await empty.scan(f.project)).sources.every((s) => s.state === 'missing'));
    await writeFile(join(f.claude, 'projects/encoded-collision/bad.jsonl'), 'not JSON\n');
    if (process.platform !== 'win32') {
      await symlink(f.c, join(f.claude, 'projects/encoded-collision/escape.jsonl'));
      await rm(join(f.project, '.codex'), { recursive: true });
      await symlink(f.codex, join(f.project, '.codex'));
    }
    const data = await f.reader.scan(f.project, true);
    assert.ok(data.sources.some((s) => s.provider === 'claude' && s.state === 'partial'));
    if (process.platform !== 'win32')
      assert.ok(
        data.configs.some((c) => c.path.endsWith('.codex/config.toml') && c.state === 'unreadable'),
      );
    const codex = data.sessions.find((s) => s.provider === 'codex')!;
    await appendFile(
      f.c,
      JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(1100000) } }) +
        '\n' +
        JSON.stringify({
          type: 'response_item',
          payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Recent text' }] },
        }) +
        '\n{',
    );
    const output = await f.reader.output(f.project, codex.id);
    assert.ok(output.truncated);
    assert.equal(output.entries.at(-1)?.text, 'Recent text');
    await writeFile(
      f.c,
      JSON.stringify({ type: 'session_meta', payload: { id: 'changed', cwd: f.other } }) + '\n',
    );
    await assert.rejects(f.reader.output(f.project, codex.id), /no longer matches/);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(join(f.claude, 'projects'), 0);
      try {
        assert.ok(
          (await f.reader.scan(f.project, true)).sources.some(
            (s) => s.provider === 'claude' && s.state === 'unreadable',
          ),
        );
      } finally {
        await chmod(join(f.claude, 'projects'), 0o700);
      }
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('native history API requires auth, returns both real fixture transcripts and refuses foreign paths', async () => {
  const f = await fixture();
  const oldCodex = process.env.CODEX_HOME,
    oldClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = f.codex;
  process.env.CLAUDE_CONFIG_DIR = f.claude;
  const { Orchestrator } = await import('../packages/orchestration/service.ts');
  const { createApp } = await import('../apps/server/src/app.ts');
  const svc = new Orchestrator(join(f.root, 'workspace'));
  const project = await svc.createProject({ name: 'History', repoPath: f.project, concurrency: 2 });
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    const url = `/api/projects/${project.id}/local-history`;
    assert.equal((await app.inject({ url, headers: { host: 'localhost' } })).statusCode, 401);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sessions.length, 2);
    for (const session of response.json().sessions) {
      const transcript = await app.inject({ url: url + '/' + session.id, headers });
      assert.equal(transcript.statusCode, 200);
      assert.ok(transcript.json().entries.some((e: { text: string }) => e.text.includes('原文')));
    }
    const treeUrl = `/api/projects/${project.id}/history-task-tree`;
    assert.equal(
      (await app.inject({ url: treeUrl, headers: { host: 'localhost' } })).statusCode,
      401,
    );
    const tree = await app.inject({ url: treeUrl, headers });
    assert.equal(tree.statusCode, 200);
    assert.equal(tree.json().nodes.filter((n: { kind: string }) => n.kind === 'session').length, 2);
    assert.equal(svc.snapshot().tasks.length, 0);
    assert.equal((await app.inject({ url: url + '/arbitrary-path', headers })).statusCode, 400);
    svc.deleteProject(project.id);
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
    assert.equal((await app.inject({ url: treeUrl, headers })).statusCode, 404);
    assert.ok((await readFile(f.c, 'utf8')).includes('npm test 中文 原文'));
  } finally {
    await app.close();
    await svc.shutdown();
    await rm(f.root, { recursive: true, force: true });
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  }
});

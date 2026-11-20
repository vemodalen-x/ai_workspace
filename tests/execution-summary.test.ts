import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHistory, taskExecutionSummary } from '../packages/orchestration/execution-summary.ts';
import type { Session } from '../packages/shared/index.ts';
import { fixture, key, settle } from './helpers.ts';
import { createApp } from '../apps/server/src/app.ts';

test('task summaries retain separate failed and resumed runs and read events outside the snapshot window', async () => {
  const { svc, project } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  try {
    const task = svc.saveTask(project.id, { title: 'Summary evidence' });
    const other = svc.saveTask(project.id, { title: 'Unrelated' });
    const run = svc.enqueue(task.id, { requestKey: key() });
    await settle(svc, [run.id]);
    svc.store.event(
      { type: 'MessageDelta', data: { text: 'Verified test evidence Bearer abc.def.ghi' } },
      { runId: run.id },
    );
    for (let index = 0; index < 5100; index++)
      svc.store.event({ type: 'Log', data: { text: 'unrelated recent noise' } });
    const failed = {
      ...svc.store.get('runs', run.id),
      id: key(),
      requestKey: key(),
      state: 'failed' as const,
      error: 'Connection lost',
    };
    svc.store.put('runs', failed);
    svc.store.event(
      { type: 'ToolStarted', data: { name: 'exec_command', input: { cmd: 'npm run typecheck' } } },
      { runId: run.id },
    );
    const summary = await taskExecutionSummary(svc.store, task.id);
    assert.ok(
      summary.runs.find((item) => item.id === run.id)!.commands.includes('npm run typecheck'),
    );
    assert.equal(summary.runs.length, 2);
    assert.ok(
      summary.runs.some((item) => item.state === 'failed' && item.error === 'Connection lost'),
    );
    assert.match(
      summary.runs.find((item) => item.id === run.id)!.conclusion,
      /Verified test evidence/,
    );
    assert.doesNotMatch(JSON.stringify(summary), /abc.def.ghi|unrelated recent noise/);
    assert.equal((await taskExecutionSummary(svc.store, other.id)).runs.length, 0);
    const headers = { host: 'localhost', authorization: `Bearer ${token}` };
    assert.equal(
      (await app.inject({ url: `/api/tasks/${task.id}/summary`, headers })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `/api/tasks/${task.id}/summary?history=bad`, headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: '/api/tasks/missing/summary', headers })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `/api/tasks/${task.id}/summary`, headers: { host: 'localhost' } }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('Codex and Claude native imports verify session/worktree, tolerate broken lines, and never merge unrelated sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'summary-history-'));
  const roots = { codex: join(root, 'codex'), claude: join(root, 'claude') };
  const session: Session = {
    id: key(),
    taskId: key(),
    projectId: key(),
    workspaceId: key(),
    provider: 'codex',
    nodeId: 'local',
    providerSessionId: key(),
    createdAt: new Date().toISOString(),
    closed: true,
  };
  const cwd = '/fixture/worktree';
  await mkdir(roots.codex);
  await mkdir(roots.claude);
  const codexFile = join(roots.codex, `rollout-${session.providerSessionId}.jsonl`);
  try {
    await writeFile(
      codexFile,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: session.providerSessionId, cwd } }),
        '{broken',
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'npm test' }),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ text: 'Implemented matting; tests passed.' }],
          },
        }),
      ].join('\n'),
    );
    await writeFile(
      codexFile,
      '\n' +
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'analysis',
            content: [{ text: 'PRIVATE REASONING' }],
          },
        }) +
        '\n' +
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            input: 'text(await tools.exec_command({cmd:"npm run build"}))',
          },
        }),
      { flag: 'a' },
    );
    const codex = await loadHistory(session, cwd, roots);
    assert.equal(codex.status, 'loaded');
    assert.equal(codex.commands?.length, 2);
    assert.equal(codex.commands?.[0], 'npm test');
    assert.match(codex.commands![1], /npm run build/);
    assert.doesNotMatch(JSON.stringify(codex), /PRIVATE REASONING/);
    assert.match(codex.conclusion!, /matting/);
    assert.match(codex.detail, /1 malformed/);
    assert.equal((await loadHistory(session, '/wrong/worktree', roots)).status, 'unavailable');
    if (process.platform !== 'win32') {
      const linked = join(roots.codex, 'linked');
      await symlink(root, linked, 'dir');
      const outside = join(root, `outside-${session.providerSessionId}.jsonl`);
      await writeFile(outside, await readFile(codexFile));
      await unlink(codexFile);
      await symlink(outside, codexFile);
      assert.equal((await loadHistory(session, cwd, roots)).status, 'unavailable');
      await unlink(codexFile);
      await writeFile(codexFile, await readFile(outside));
    }
    const claude = { ...session, provider: 'claude' as const, providerSessionId: key() };
    await writeFile(
      join(roots.claude, `${claude.providerSessionId}.jsonl`),
      [
        {
          sessionId: claude.providerSessionId,
          cwd,
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Claude evidence' },
              { type: 'tool_use', name: 'Write', input: { file_path: 'exp/main.py' } },
            ],
          },
        },
        {
          sessionId: 'other-session',
          cwd,
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'PRIVATE OTHER TASK' }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
    const result = await loadHistory(claude, cwd, roots);
    assert.equal(result.status, 'loaded');
    assert.equal(result.conclusion, 'Claude evidence');
    assert.deepEqual(result.files, ['exp/main.py']);
    assert.equal(
      (await loadHistory({ ...session, nodeId: 'remote' }, cwd, roots)).status,
      'skipped',
    );
    assert.equal(
      (await loadHistory({ ...session, providerSessionId: '../../etc/passwd' }, cwd, roots)).status,
      'unavailable',
    );
    assert.equal(
      (await loadHistory({ ...session, providerSessionId: key() }, cwd, roots)).status,
      'unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

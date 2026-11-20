import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveHistoryTasks } from '../packages/orchestration/history-task-tree.ts';
import { NativeHistoryReader } from '../packages/orchestration/native-history.ts';
import type { NativeSession } from '../packages/shared/native-history.ts';
const session = (provider: 'codex' | 'claude'): NativeSession => ({
  id: provider + '-source',
  provider,
  providerSessionId: 'native-session',
  cwd: '/project',
  modifiedAt: '2026-11-18',
  bytes: 0,
});
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (text: string, ordinal?: number) => ({
  type: 'response_item',
  ordinal,
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const plan = (steps: { step: string; status: string }[]) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'update_plan',
    arguments: JSON.stringify({ plan: steps }),
  },
});

test('Codex requests and explicit plans form stable trees without mistaking assistant output, injections or duplicate user events for tasks', () => {
  const text = jsonl(
    user('# AGENTS.md instructions\nInjected context', 0),
    user('实现中文 --flag', 1),
    { type: 'event_msg', payload: { type: 'user_message', message: '实现中文 --flag' } },
    plan([
      { step: 'Inspect code', status: 'in_progress' },
      { step: 'Validate', status: 'pending' },
    ]),
    plan([
      { step: 'Inspect code', status: 'completed' },
      { step: 'Validate', status: 'in_progress' },
    ]),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Everything done' }],
      },
    },
    user('继续', 2),
    user('继续', 3),
  );
  const tree = deriveHistoryTasks(session('codex'), text);
  assert.equal(tree.nodes.filter((n) => n.kind === 'session').length, 1);
  assert.equal(tree.nodes.filter((n) => n.kind === 'request').length, 3);
  assert.equal(tree.nodes.filter((n) => n.kind === 'plan').length, 2);
  assert.equal(tree.nodes.find((n) => n.title === 'Inspect code')?.state, 'completed');
  const first = tree.nodes.find((n) => n.title === '实现中文 --flag')!;
  assert.equal(first.state, 'recorded');
  assert.ok(tree.nodes.filter((n) => n.kind === 'plan').every((n) => n.parentId === first.id));
  assert.deepEqual(deriveHistoryTasks(session('codex'), text).nodes, tree.nodes);
  const appended = deriveHistoryTasks(session('codex'), text + jsonl(user('New request', 4)));
  assert.deepEqual(appended.nodes.slice(0, tree.nodes.length), tree.nodes);
  assert.equal(new Set(appended.nodes.map((n) => n.id)).size, appended.nodes.length);
});

test('Claude tool-result messages and message parent links are not tasks; TodoWrite states update only the current request', () => {
  const records = [
    {
      type: 'user',
      uuid: 'one',
      sessionId: 'native-session',
      parentUuid: 'previous-assistant',
      message: { content: 'Original 中文 task' },
    },
    {
      type: 'assistant',
      sessionId: 'native-session',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Do work', status: 'pending' }] },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'tool-result',
      sessionId: 'native-session',
      message: { content: [{ type: 'tool_result', content: 'Success' }] },
    },
    {
      type: 'assistant',
      sessionId: 'native-session',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Do work', status: 'completed' }] },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'side',
      sessionId: 'native-session',
      isSidechain: true,
      message: { content: 'Subagent instruction' },
    },
    { type: 'user', uuid: 'foreign', sessionId: 'other', message: { content: 'Other project' } },
    {
      type: 'user',
      uuid: 'two',
      sessionId: 'native-session',
      parentUuid: 'one',
      message: { content: 'Follow up' },
    },
  ];
  const { nodes } = deriveHistoryTasks(session('claude'), jsonl(...records));
  assert.equal(nodes.length, 4);
  assert.ok(nodes.filter((n) => n.kind === 'request').every((n) => n.parentId === nodes[0].id));
  assert.equal(nodes.find((n) => n.title === 'Do work')?.state, 'completed');
  const limited = deriveHistoryTasks(session('claude'), jsonl(...records), 0, 2);
  assert.equal(limited.nodes.length, 2);
  assert.ok(limited.truncated);
  assert.ok(
    limited.nodes.every((n) => !n.parentId || limited.nodes.some((p) => p.id === n.parentId)),
  );
});

test('malformed records, no owning request and partial final writes are reported; descriptions are redacted before titles', () => {
  const old = process.env.TREE_TEST_API_KEY;
  process.env.TREE_TEST_API_KEY = 'secret-value-for-tree';
  try {
    const result = deriveHistoryTasks(
      session('codex'),
      'not json\n' +
        jsonl(
          plan([{ step: 'Unknown parent', status: 'completed' }]),
          user('secret-value-for-tree', 1),
        ) +
        '{"type":',
    );
    assert.ok(result.skipped >= 2);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.nodes[1].title, '[REDACTED]');
  } finally {
    if (old === undefined) delete process.env.TREE_TEST_API_KEY;
    else process.env.TREE_TEST_API_KEY = old;
  }
});

test('reader auto-refreshes appended histories, deduplicates native sessions and keeps offset IDs stable across UTF-8 tail windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-tree-'));
  const project = join(root, 'project'),
    codex = join(root, 'codex'),
    claude = join(root, 'claude');
  await mkdir(project);
  await mkdir(join(codex, 'sessions'), { recursive: true });
  const file = join(codex, 'sessions/rollout.jsonl');
  const meta = { type: 'session_meta', payload: { id: 'one', cwd: project } };
  await writeFile(file, jsonl(meta, user('Earlier request')));
  const reader = new NativeHistoryReader({ codex, claude });
  try {
    const first = await reader.taskTree(project, true);
    assert.equal(first.nodes.filter((n) => n.kind === 'request').length, 1);
    await appendFile(
      file,
      jsonl(
        { type: 'event_msg', payload: { type: 'log', text: '中'.repeat(3000000) } },
        user('Recent 原始 request'),
      ),
    );
    const second = await reader.taskTree(project, true);
    assert.ok(second.truncated);
    const recent = second.nodes.find((n) => n.title === 'Recent 原始 request')!;
    assert.ok(recent);
    await appendFile(file, jsonl(user('Append request')));
    const third = await reader.taskTree(project, true);
    assert.equal(third.nodes.find((n) => n.title === 'Recent 原始 request')?.id, recent.id);
    assert.ok(third.nodes.some((n) => n.title === 'Append request'));
    await writeFile(join(codex, 'sessions/copy.jsonl'), jsonl(meta, user('Mirror request')));
    const fourth = await reader.taskTree(project, true);
    assert.equal(fourth.nodes.filter((n) => n.kind === 'session').length, 1);
    const other = join(root, 'other');
    await mkdir(other);
    assert.equal((await reader.taskTree(other, true)).nodes.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context blocks inside a Codex user message do not hide its real request', () => {
  const tree = deriveHistoryTasks(
    session('codex'),
    jsonl({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>context</environment_context>' },
          { type: 'input_text', text: 'Please implement 原始 request' },
        ],
      },
    }),
  );
  assert.equal(tree.nodes.filter((n) => n.kind === 'request').length, 1);
  assert.equal(tree.nodes[1].title, 'Please implement 原始 request');
});

test('a plan with an explicit identity keeps its node while updating text and status', () => {
  const call = (content: string, status: string) => ({
    type: 'assistant',
    sessionId: 'native-session',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: { todos: [{ id: 'same-step', content, status }] },
        },
      ],
    },
  });
  const request = {
    type: 'user',
    uuid: 'request',
    sessionId: 'native-session',
    message: { content: 'Task' },
  };
  const first = deriveHistoryTasks(
    session('claude'),
    jsonl(request, call('Initial step', 'pending')),
  );
  const latest = deriveHistoryTasks(
    session('claude'),
    jsonl(request, call('Initial step', 'pending'), call('Updated 原始 step', 'completed')),
  );
  assert.equal(first.nodes.at(-1)?.id, latest.nodes.at(-1)?.id);
  assert.equal(latest.nodes.at(-1)?.title, 'Updated 原始 step');
  assert.equal(latest.nodes.at(-1)?.state, 'completed');
  assert.equal(latest.nodes.length, first.nodes.length);
});

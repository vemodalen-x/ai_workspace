import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  symlink,
  chmod,
  stat,
  utimes,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionIndex } from '../packages/orchestration/session-index.ts';
import { openTranscripts } from '../packages/orchestration/process-probe.ts';
import {
  buildMonitorOverview,
  resumeCommand,
  type IndexedSession,
  type MonitorState,
} from '../packages/shared/monitoring.ts';
import { createApp } from '../apps/server/src/app.ts';
import { fixture as serviceFixture } from './helpers.ts';

// Built at runtime so secret scanners do not flag the fixture.
const fakeKey = ['sk', 'abcdefghijklmnop1234'].join('-');
const line = (value: unknown) => JSON.stringify(value) + '\n';
const meta = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  line({
    timestamp: '2026-11-20T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, cwd, timestamp: '2026-11-20T10:00:00.000Z', ...extra },
  });
const userText = (text: string) =>
  line({
    timestamp: '2026-11-20T10:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
const event = (type: string, timestamp = '2026-11-20T10:00:02.000Z') =>
  line({ timestamp, type: 'event_msg', payload: { type } });
const emptyState = (): MonitorState => ({
  projects: [],
  tasks: [],
  sessions: [],
  runs: [],
  workspaces: [],
  approvals: [],
  attempts: [],
  briefing: {
    generatedAt: '',
    items: [],
    running: 0,
    review: { since: '', completed: 0, failed: 0, commandPassed: 0, unverified: 0 },
  },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-index-'));
  const project = join(root, 'project'),
    worktree = join(root, 'worktrees', 'managed'),
    elsewhere = join(root, 'elsewhere'),
    codex = join(root, 'codex'),
    claude = join(root, 'claude'),
    day = join(codex, 'sessions/2026/11/20');
  for (const dir of [
    project,
    join(project, 'packages/api'),
    worktree,
    elsewhere,
    day,
    join(claude, 'projects/-project'),
  ])
    await mkdir(dir, { recursive: true });
  const files = {
    cli: join(day, 'rollout-cli.jsonl'),
    ide: join(day, 'rollout-ide.jsonl'),
    vscode: join(day, 'rollout-vscode.jsonl'),
    sub: join(day, 'rollout-sub.jsonl'),
    managed: join(day, 'rollout-managed.jsonl'),
    claude: join(claude, 'projects/-project/claude-one.jsonl'),
    claudeError: join(claude, 'projects/-project/claude-two.jsonl'),
  };
  await writeFile(
    files.cli,
    meta('codex-cli', project, { originator: 'codex_cli_rs', source: 'cli' }) +
      userText('<environment_context>injected</environment_context>') +
      userText('Fix the parser ' + fakeKey) +
      event('task_started') +
      event('task_complete'),
  );
  await writeFile(
    files.ide,
    meta('codex-ide', join(project, 'packages/api'), {
      originator: 'codemoss_intellij',
      source: 'vscode',
    }) +
      userText('Add endpoint') +
      event('task_started'),
  );
  await writeFile(
    files.vscode,
    meta('codex-vscode', elsewhere, { originator: 'codex_vscode', source: 'vscode' }) +
      userText('Unrelated folder') +
      event('task_started') +
      event('turn_aborted'),
  );
  await writeFile(
    files.sub,
    meta('codex-sub', project, {
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: 'codex-cli', depth: 1, agent_nickname: 'Hume' },
        },
      },
    }) + userText('Explore'),
  );
  await writeFile(
    files.managed,
    meta('codex-managed', worktree, { originator: 'codex_sdk_ts', source: 'exec' }) +
      userText('Managed task') +
      event('task_started') +
      event('task_complete'),
  );
  await writeFile(
    files.claude,
    line({
      type: 'user',
      sessionId: 'claude-one',
      cwd: project,
      entrypoint: 'cli',
      timestamp: '2026-11-20T10:00:00.000Z',
      message: { role: 'user', content: 'Write docs' },
    }) +
      line({
        type: 'assistant',
        sessionId: 'claude-one',
        timestamp: '2026-11-20T10:00:05.000Z',
        message: { role: 'assistant', stop_reason: 'tool_use', content: [] },
      }),
  );
  await writeFile(
    files.claudeError,
    line({
      type: 'user',
      sessionId: 'claude-two',
      cwd: project,
      entrypoint: 'claude-vscode',
      message: { role: 'user', content: 'Try again' },
    }) +
      line({
        type: 'assistant',
        sessionId: 'claude-two',
        isApiErrorMessage: true,
        message: { role: 'assistant', stop_reason: 'stop_sequence', content: [] },
      }),
  );
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('codex-cli', project, '', 'Parser fix');
  db.close();
  return { root, project, worktree, elsewhere, codex, claude, files };
}

test('session index discovers CLI, IDE plugin, subagent and Claude sessions read-only', async () => {
  const f = await fixture();
  const before = await Promise.all(
    Object.values(f.files).map(async (p) => [await readFile(p, 'utf8'), (await stat(p)).mtimeMs]),
  );
  const index = new SessionIndex({ codex: f.codex, claude: f.claude });
  await index.refresh();
  const sessions = await index.sessions();
  const by = (id: string) => sessions.find((s) => s.providerSessionId === id)!;
  assert.equal(sessions.length, 7);
  assert.deepEqual(
    [by('codex-cli').client, by('codex-ide').client, by('codex-vscode').client],
    ['cli', 'jetbrains', 'vscode'],
  );
  assert.equal(by('codex-ide').clientDetail, 'codemoss_intellij');
  assert.equal(by('codex-sub').client, 'subagent');
  assert.equal(by('codex-sub').parentSessionId, 'codex-cli');
  assert.equal(by('codex-sub').clientDetail, 'Hume');
  assert.equal(by('codex-managed').client, 'sdk');
  assert.equal(by('claude-one').client, 'cli');
  assert.equal(by('claude-two').client, 'vscode');
  assert.deepEqual(
    ['codex-cli', 'codex-ide', 'codex-vscode', 'claude-one', 'claude-two', 'codex-sub'].map(
      (id) => by(id).phase,
    ),
    ['waiting', 'working', 'aborted', 'working', 'error', 'unknown'],
  );
  assert.equal(by('claude-two').errors, 1);
  // Codex thread titles override the derived title; injected context is never a request.
  assert.equal(by('codex-cli').title, 'Parser fix');
  assert.equal(by('codex-cli').lastRequest, 'Fix the parser [REDACTED]');
  assert.equal(by('codex-ide').title, 'Add endpoint');
  assert.ok(!JSON.stringify(sessions).includes('abcdefghijklmnop'));
  const after = await Promise.all(
    Object.values(f.files).map(async (p) => [await readFile(p, 'utf8'), (await stat(p)).mtimeMs]),
  );
  assert.deepEqual(after, before);
});

test('overview associates exact folders and managed worktrees, suggests subfolders, derives liveness and alerts', async () => {
  const f = await fixture();
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: async () => undefined },
  );
  const clock = new Date('2026-11-20T12:00:00.000Z');
  const recent = new Date(clock.getTime() - 30_000),
    stale = new Date(clock.getTime() - 40 * 60_000),
    old = new Date(clock.getTime() - 3 * 86_400_000);
  await utimes(f.files.cli, recent, recent);
  await utimes(f.files.ide, stale, stale);
  await utimes(f.files.vscode, recent, recent);
  await utimes(f.files.claude, old, old);
  await utimes(f.files.claudeError, recent, recent);
  await utimes(f.files.sub, old, old);
  await utimes(f.files.managed, old, old);
  const state = emptyState();
  state.projects = [
    {
      id: 'p1',
      name: 'Project',
      repoPath: f.project,
      baseBranch: 'main',
      concurrency: 1,
      archived: false,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'gone',
      name: 'Removed',
      repoPath: f.elsewhere,
      baseBranch: 'main',
      concurrency: 1,
      archived: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      removedAt: '2026-11-02T00:00:00.000Z',
    },
  ];
  state.workspaces = [
    {
      id: 'w1',
      sessionId: 'managed-session',
      projectId: 'p1',
      path: f.worktree,
      branch: 'b',
      baseCommit: 'c',
      nodeId: 'local',
      cleaned: false,
      integrationCommits: [],
    },
  ];
  const overview = await index.overview(state, { clock });
  const by = (id: string) => overview.sessions.find((s) => s.providerSessionId === id)!;
  assert.equal(by('codex-cli').association, 'exact');
  assert.equal(by('codex-cli').projectId, 'p1');
  assert.equal(by('codex-cli').liveness, 'active');
  assert.equal(by('codex-managed').association, 'managed');
  assert.equal(by('codex-managed').managedSessionId, 'managed-session');
  assert.equal(by('codex-ide').association, 'unassigned');
  assert.equal(by('codex-ide').suggestedProjectId, 'p1');
  assert.equal(by('codex-ide').stalled, true);
  assert.equal(by('codex-vscode').association, 'unassigned', 'removed projects never own sessions');
  assert.equal(by('codex-vscode').suggestedProjectId, undefined);
  assert.equal(by('claude-one').liveness, 'dormant');
  assert.equal(by('claude-one').stalled, false, 'old unfinished turns are history, not alerts');
  const kinds = overview.alerts.map((a) => `${a.kind}:${a.severity}`);
  assert.ok(kinds.includes('session_error:error'));
  assert.ok(kinds.includes('session_stalled:warning'));
  assert.ok(kinds.includes('session_aborted:info'));
  assert.ok(kinds.includes('unassigned_active:info'));
  assert.equal(overview.alerts[0].severity, 'error');
  assert.equal(overview.projects.length, 1);
  assert.equal(overview.projects[0].health, 'blocked');
  assert.equal(overview.totals.active, 3);
  assert.equal(by('codex-cli').resumeCommand, `cd '${f.project}' && codex resume codex-cli`);
  assert.equal(
    resumeCommand({ provider: 'claude', cwd: "/tmp/it's here", providerSessionId: 'abc' }),
    `cd '/tmp/it'\\''s here' && claude --resume abc`,
  );
});

test('refresh is incremental, re-reads appended files, skips symlinks and resumes after the byte budget', async () => {
  const f = await fixture();
  const index = new SessionIndex({ codex: f.codex, claude: f.claude }, { budget: 1 });
  const newest = new Date(Date.now() + 60_000);
  await utimes(f.files.claude, newest, newest);
  const first = await index.overview(emptyState(), { refresh: true });
  // The newest file consumes the tiny budget; the rest wait for later refreshes without
  // being reported as a degraded source.
  let sessions = await index.sessions();
  assert.deepEqual(
    sessions.map((s) => s.providerSessionId),
    ['claude-one'],
  );
  assert.deepEqual(
    first.sources.map((s) => [s.state, s.pending]),
    [
      ['available', 5],
      ['missing', 0],
      ['available', 1],
      ['available', 0],
    ],
  );
  assert.ok(!first.alerts.some((a) => a.kind === 'source_degraded'));
  for (let i = 0; i < 10 && sessions.length < 7; i++) {
    await index.refresh();
    sessions = await index.sessions();
  }
  assert.equal(sessions.length, 7);
  const full = new SessionIndex({ codex: f.codex, claude: f.claude });
  await full.refresh();
  if (process.getuid?.() !== 0) {
    // Unchanged size/mtime/inode: the cached result is reused without opening the file.
    await chmod(f.files.cli, 0o000);
    await full.refresh();
    assert.equal((await full.sessions()).length, 7);
    await chmod(f.files.cli, 0o600);
  }
  await appendFile(f.files.ide, event('task_complete', '2026-11-20T10:05:00.000Z'));
  await full.refresh();
  assert.equal(
    (await full.sessions()).find((s) => s.providerSessionId === 'codex-ide')?.phase,
    'waiting',
  );
  await symlink(f.files.cli, join(f.codex, 'sessions/2026/11/20/rollout-link.jsonl'));
  await rm(f.files.vscode);
  const overview = await full.overview(emptyState(), { refresh: true });
  assert.equal(overview.sessions.length, 6, 'deleted files leave the index');
  assert.equal(overview.sources.find((s) => s.path.endsWith('sessions'))?.state, 'partial');
  assert.ok(overview.alerts.some((a) => a.kind === 'source_degraded'));
  assert.equal(
    overview.sources.find((s) => s.path.endsWith('archived_sessions'))?.state,
    'missing',
  );
  assert.ok(!overview.alerts.some((a) => a.title.endsWith('archived_sessions')));
});

test('long turns keep their state across appended reads beyond the first window', async () => {
  const f = await fixture();
  const index = new SessionIndex({ codex: f.codex, claude: f.claude });
  await index.refresh();
  const phase = async () =>
    (await index.sessions()).find((s) => s.providerSessionId === 'codex-ide')?.phase;
  assert.equal(await phase(), 'working');
  // Each refresh reads only the appended bytes, so task_started stays known even after the
  // transcript has grown far past the 4 MiB window used for a first read.
  const filler = line({
    timestamp: '2026-11-20T10:01:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', output: 'x'.repeat(64 * 1024) },
  });
  for (let i = 0; i < 6; i++) {
    await appendFile(f.files.ide, filler.repeat(16));
    await index.refresh();
    assert.equal(await phase(), 'working');
  }
  // A partially written line is not consumed until it is complete.
  const done = event('task_complete', '2026-11-20T11:00:00.000Z');
  await appendFile(f.files.ide, done.slice(0, 20));
  await index.refresh();
  assert.equal(await phase(), 'working');
  await appendFile(f.files.ide, done.slice(20));
  await index.refresh();
  assert.equal(await phase(), 'waiting');
  // A replaced file (new inode) is parsed from scratch.
  await rm(f.files.ide);
  await writeFile(f.files.ide, meta('codex-ide', f.project) + userText('Again'));
  await index.refresh();
  assert.equal(await phase(), 'unknown');
});

test('open transcript descriptors separate long-running turns from processes that exited mid-turn', async () => {
  const f = await fixture();
  const proc = join(f.root, 'proc');
  const fakeProcess = async (pid: string, comm: string, target: string) => {
    await mkdir(join(proc, pid, 'fd'), { recursive: true });
    await writeFile(join(proc, pid, 'comm'), comm + '\n');
    await symlink(target, join(proc, pid, 'fd', '3'));
  };
  await fakeProcess('100', 'codex', await realpath(f.files.ide));
  // Other programs holding a transcript (an editor, tail -f) do not count.
  await fakeProcess('200', 'less', await realpath(f.files.vscode));
  await mkdir(join(proc, 'self'));
  const clock = new Date('2026-11-20T12:00:00.000Z');
  const quiet = new Date(clock.getTime() - 40 * 60_000);
  for (const file of Object.values(f.files)) await utimes(file, quiet, quiet);
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: () => openTranscripts(proc) },
  );
  let overview = await index.overview(emptyState(), { clock, refresh: true });
  const by = (id: string) => overview.sessions.find((s) => s.providerSessionId === id)!;
  assert.equal(overview.processesObserved, true);
  assert.equal(by('codex-ide').process, 'attached');
  assert.equal(by('codex-vscode').process, 'detached');
  assert.equal(by('claude-one').process, undefined, 'Claude Code does not keep files open');
  // A silent turn inside a live process may be waiting on a command or approval.
  assert.equal(by('codex-ide').stalled, true);
  assert.equal(by('codex-ide').endedMidTurn, false);
  assert.equal(overview.totals.attached, 1);
  assert.equal(overview.totals.working, 1, 'held turns count even after 2 quiet minutes');
  assert.equal(by('claude-one').stalled, true, 'unobservable sessions keep the write-time rule');

  await rm(join(proc, '100'), { recursive: true });
  overview = await index.overview(emptyState(), { clock, refresh: true });
  assert.equal(by('codex-ide').process, 'detached');
  assert.equal(by('codex-ide').endedMidTurn, true);
  assert.equal(by('codex-ide').stalled, false);
  assert.ok(overview.alerts.some((a) => a.kind === 'session_ended' && a.severity === 'warning'));
  assert.ok(!overview.alerts.some((a) => a.id === 'session_stalled:' + by('codex-ide').id));
  assert.equal(overview.totals.working, 0);

  const unobserved = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: async () => undefined },
  );
  overview = await unobserved.overview(emptyState(), { clock, refresh: true });
  assert.equal(overview.processesObserved, false);
  assert.equal(by('codex-ide').process, undefined);
  assert.equal(by('codex-ide').stalled, true);
  assert.equal(await openTranscripts(join(f.root, 'missing')), undefined);
});

test('offsets count raw bytes, rewritten files are re-identified and non-turn Claude records keep the phase', async () => {
  const f = await fixture();
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: async () => undefined },
  );
  await index.refresh();
  const find = async (id: string) =>
    (await index.sessions()).find((s) => s.providerSessionId === id);
  // An invalid byte decodes to U+FFFD (3 bytes); the resume offset must not drift past it.
  await appendFile(
    f.files.cli,
    Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
  );
  await index.refresh();
  await appendFile(f.files.cli, event('task_started', '2026-11-20T10:10:00.000Z'));
  await index.refresh();
  assert.equal((await find('codex-cli'))?.phase, 'working');

  // Same path and inode, different content that is at least as large: parsed from scratch.
  const content = await readFile(f.files.managed, 'utf8');
  const replacement = meta('codex-other', f.project) + userText('Other '.repeat(80));
  assert.ok(Buffer.byteLength(replacement) >= Buffer.byteLength(content));
  await writeFile(f.files.managed, replacement);
  await index.refresh();
  assert.equal(await find('codex-managed'), undefined);
  assert.equal((await find('codex-other'))?.title?.startsWith('Other'), true);

  // Slash commands, shell input and compaction summaries are not model turns or requests.
  const claude = (extra: Record<string, unknown>, content: string) =>
    line({
      type: 'user',
      sessionId: 'claude-two',
      timestamp: '2026-11-20T10:20:00.000Z',
      message: { role: 'user', content },
      ...extra,
    });
  await appendFile(
    f.files.claudeError,
    line({
      type: 'assistant',
      sessionId: 'claude-two',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
    }) +
      claude({}, '<command-name>/model</command-name>') +
      claude({}, '<local-command-stdout>Set model</local-command-stdout>') +
      claude({}, '<bash-input>ls</bash-input>') +
      claude(
        { isCompactSummary: true, isVisibleInTranscriptOnly: true },
        'Summary of earlier work',
      ),
  );
  await index.refresh();
  const two = await find('claude-two');
  assert.equal(two?.phase, 'waiting');
  assert.equal(two?.lastRequest, 'Try again');

  // A removed root drops its sessions instead of keeping stale entries.
  await rm(join(f.claude, 'projects'), { recursive: true });
  await index.refresh();
  assert.equal(await find('claude-one'), undefined);
});

test('the latest model and context usage come from turn records, not sidechains or API errors', async () => {
  const f = await fixture();
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: async () => undefined },
  );
  await index.refresh();
  const find = async (id: string) =>
    (await index.sessions()).find((s) => s.providerSessionId === id);
  const usage = (total: number, window?: number) =>
    line({
      timestamp: '2026-11-20T10:30:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: total * 3 },
          last_token_usage: { input_tokens: total - 100, output_tokens: 100, total_tokens: total },
          model_context_window: window,
        },
      },
    });
  await appendFile(
    f.files.cli,
    line({ type: 'turn_context', payload: { model: 'gpt-test', cwd: f.project } }) +
      usage(64000, 256000) +
      // Rate-limit-only updates carry no usage and keep the previous value.
      line({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
  );
  await index.refresh();
  const cli = await find('codex-cli');
  assert.equal(cli?.model, 'gpt-test');
  assert.deepEqual(cli?.context, { tokens: 64000, window: 256000 });

  const assistant = (extra: Record<string, unknown>, model: string, input: number) =>
    line({
      type: 'assistant',
      sessionId: 'claude-two',
      timestamp: '2026-11-20T10:30:00.000Z',
      message: {
        role: 'assistant',
        model,
        stop_reason: 'end_turn',
        content: [],
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 20000,
          output_tokens: 500,
        },
      },
      ...extra,
    });
  await appendFile(
    f.files.claudeError,
    assistant({}, 'claude-test', 10) +
      assistant({ isSidechain: true }, 'claude-side', 90000) +
      assistant({ isApiErrorMessage: true }, '<synthetic>', 0),
  );
  await index.refresh();
  const two = await find('claude-two');
  assert.equal(two?.model, 'claude-test');
  assert.deepEqual(two?.context, { tokens: 21510 });

  // The model stays known when the last turn context is older than the tail window.
  const long = join(f.codex, 'sessions/2026/11/20/rollout-long-turn.jsonl');
  await writeFile(
    long,
    meta('codex-long-model', f.project) +
      line({ type: 'turn_context', payload: { model: 'gpt-head' } }) +
      event('task_started') +
      userText('x'.repeat(400 * 1024)) +
      event('agent_message'),
  );
  const old = new Date(Date.now() - 2 * 86_400_000);
  await utimes(long, old, old);
  await index.refresh();
  const longTurn = await find('codex-long-model');
  assert.equal(longTurn?.model, 'gpt-head');
  assert.equal(longTurn?.context, undefined);
});

test('pending tool calls and plans show progress, and Claude questions wait for an answer', async () => {
  const f = await fixture();
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { probe: async () => undefined },
  );
  await index.refresh();
  const find = async (id: string) =>
    (await index.sessions()).find((s) => s.providerSessionId === id);
  const item = (payload: Record<string, unknown>, timestamp = '2026-11-20T10:40:00.000Z') =>
    line({ timestamp, type: 'response_item', payload });
  const plan = JSON.stringify({
    plan: [
      { step: 'Read code', status: 'completed' },
      { step: 'Write ' + fakeKey, status: 'in_progress' },
      { step: 'Verify', status: 'pending' },
    ],
  });
  await appendFile(
    f.files.cli,
    event('task_started', '2026-11-20T10:39:00.000Z') +
      item({ type: 'function_call', name: 'update_plan', arguments: plan, call_id: 'c1' }) +
      item({ type: 'function_call_output', call_id: 'c1', output: 'ok' }) +
      item({ type: 'custom_tool_call', name: 'exec', input: 'npm test', call_id: 'c2' }),
  );
  await index.refresh();
  let cli = await find('codex-cli');
  assert.equal(cli?.phase, 'working');
  assert.deepEqual(cli?.activity, { tool: 'exec', since: '2026-11-20T10:40:00.000Z' });
  assert.equal(cli?.plan?.done, 1);
  assert.equal(cli?.plan?.total, 3);
  assert.ok(cli?.plan?.current?.startsWith('Write ') && !cli.plan.current.includes(fakeKey));
  // A finished turn leaves nothing running; the plan stays as the last recorded state.
  await appendFile(f.files.cli, event('task_complete', '2026-11-20T10:41:00.000Z'));
  await index.refresh();
  cli = await find('codex-cli');
  assert.equal(cli?.activity, undefined);
  assert.equal(cli?.plan?.total, 3);

  const claude = (type: string, content: unknown[], extra: Record<string, unknown> = {}) =>
    line({
      type,
      sessionId: 'claude-two',
      timestamp: '2026-11-20T10:40:00.000Z',
      message: { role: type, content, stop_reason: type === 'assistant' ? 'tool_use' : undefined },
      ...extra,
    });
  await appendFile(
    f.files.claudeError,
    claude('user', [{ type: 'text', text: 'Plan the change' }]) +
      claude('assistant', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Ask', status: 'in_progress' }] },
        },
      ]) +
      claude('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]) +
      // A sidechain call does not belong to the main turn.
      claude('assistant', [{ type: 'tool_use', id: 's1', name: 'Bash', input: {} }], {
        isSidechain: true,
      }) +
      claude('assistant', [{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: {} }]),
  );
  await index.refresh();
  const two = await find('claude-two');
  assert.equal(two?.activity?.tool, 'AskUserQuestion');
  assert.deepEqual(two?.plan, {
    done: 0,
    total: 1,
    current: 'Ask',
    at: '2026-11-20T10:40:00.000Z',
  });

  // Fifty idle minutes after the last write, which would otherwise count as stalled.
  const clock = new Date(Date.parse(two!.modifiedAt) + 50 * 60_000);
  const overview = buildMonitorOverview({
    state: emptyState(),
    sessions: [two!],
    sources: [],
    projectPaths: {},
    workspacePaths: {},
    clock,
  });
  const monitored = overview.sessions[0];
  assert.equal(monitored.needsAnswer, true);
  assert.equal(monitored.stalled, false);
  assert.deepEqual(
    overview.alerts.filter((a) => a.sessionId === monitored.id).map((a) => a.kind),
    ['session_needs_answer'],
  );
});

test('the entry limit applies per source and keeps the newest Codex days', async () => {
  const f = await fixture();
  const older = join(f.codex, 'sessions/2026/10/01');
  await mkdir(older, { recursive: true });
  for (let i = 0; i < 6; i++)
    await writeFile(join(older, `rollout-old-${i}.jsonl`), meta(`codex-old-${i}`, f.project));
  // sessions/2026/{11,10} → 11/20 → 5 files fill a budget of 10 entries per source.
  const index = new SessionIndex(
    { codex: f.codex, claude: f.claude },
    { maxFiles: 10, probe: async () => undefined },
  );
  const overview = await index.overview(emptyState(), { refresh: true });
  const ids = overview.sessions.map((s) => s.providerSessionId);
  assert.ok(ids.includes('codex-cli') && ids.includes('codex-ide'));
  assert.ok(ids.includes('claude-one') && ids.includes('claude-two'));
  assert.ok(ids.filter((id) => id.startsWith('codex-old')).length < 6);
  assert.equal(overview.sources[0].state, 'partial');
});

test('monitor output is redacted, bound to indexed ids and rejects replaced transcripts', async () => {
  const f = await fixture();
  const index = new SessionIndex({ codex: f.codex, claude: f.claude });
  await index.refresh();
  const cli = (await index.sessions()).find((s) => s.providerSessionId === 'codex-cli')!;
  const output = await index.output(cli.id);
  assert.deepEqual(
    output.entries.map((e) => e.text),
    ['<environment_context>injected</environment_context>', 'Fix the parser [REDACTED]'],
  );
  await assert.rejects(index.output('f'.repeat(64)), /not found/);
  await writeFile(f.files.cli, meta('other-id', f.project) + userText('replaced'));
  await assert.rejects(index.output(cli.id), /changed/);
});

test('briefing items and recent failed attempts become project alerts', () => {
  const state = emptyState();
  const clock = new Date('2026-11-20T12:00:00.000Z');
  state.projects = [
    {
      id: 'p1',
      name: 'Alpha',
      repoPath: '/alpha',
      baseBranch: 'main',
      concurrency: 1,
      archived: false,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
  state.briefing.items = [
    {
      id: 't1:recover',
      kind: 'recover',
      taskId: 't1',
      projectId: 'p1',
      title: 'Lost run',
      reason: 'Process outcome is unknown; resources remain reserved.',
      action: '',
      priority: 1,
    },
    {
      id: 't2:clarify',
      kind: 'clarify',
      taskId: 't2',
      projectId: 'p1',
      title: 'Vague',
      reason: '',
      action: '',
      priority: 1,
    },
  ];
  state.attempts = [
    {
      id: 'a1',
      trialId: 'trial',
      projectId: 'p1',
      requestKey: 'k',
      state: 'failed',
      createdAt: '2026-11-20T11:00:00.000Z',
      endedAt: '2026-11-20T11:10:00.000Z',
    },
    {
      id: 'a0',
      trialId: 'old-trial',
      projectId: 'p1',
      requestKey: 'k',
      state: 'failed',
      createdAt: '2026-10-01T11:00:00.000Z',
      endedAt: '2026-10-01T11:10:00.000Z',
    },
  ];
  const sessions: IndexedSession[] = [];
  const overview = buildMonitorOverview({
    state,
    sessions,
    sources: [],
    projectPaths: { p1: '/alpha' },
    workspacePaths: {},
    clock,
  });
  assert.deepEqual(
    overview.alerts.map((a) => a.kind),
    ['run_orphaned', 'attempt_failed'],
  );
  assert.equal(overview.projects[0].health, 'blocked');
  assert.equal(overview.projects[0].attention, 1);
});

test('monitor API requires local authentication and validates session ids', async () => {
  const f = await fixture();
  const { svc, project } = await serviceFixture();
  const monitor = new SessionIndex({ codex: f.codex, claude: f.claude });
  const { app } = await createApp(svc, { serveWeb: false, token: 'monitor-secret', monitor });
  const headers = { host: 'localhost', authorization: 'Bearer monitor-secret' };
  try {
    assert.equal(
      (await app.inject({ url: '/api/monitor/overview', headers: { host: 'localhost' } }))
        .statusCode,
      401,
    );
    const response = await app.inject({ url: '/api/monitor/overview?refresh=true', headers });
    assert.equal(response.statusCode, 200);
    const overview = response.json();
    assert.equal(overview.sessions.length, 7);
    assert.equal(overview.projects[0].projectId, project.id);
    assert.equal(
      (await app.inject({ url: '/api/monitor/sessions/not-an-id/output', headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `/api/monitor/sessions/${'a'.repeat(64)}/output`, headers }))
        .statusCode,
      404,
    );
    const id = overview.sessions[0].id;
    assert.equal(
      (await app.inject({ url: `/api/monitor/sessions/${id}/output`, headers })).statusCode,
      200,
    );
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

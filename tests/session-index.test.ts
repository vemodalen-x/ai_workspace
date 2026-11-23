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
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionIndex } from '../packages/orchestration/session-index.ts';
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
  const index = new SessionIndex({ codex: f.codex, claude: f.claude });
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
  await index.refresh();
  // The first file consumes the tiny budget; the rest wait for later refreshes.
  let sessions = await index.sessions();
  assert.equal(sessions.length, 1);
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

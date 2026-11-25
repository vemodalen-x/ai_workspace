import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

test('monitor view is reachable, localized and read-only', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Monitor', exact: true }).click();
  await expect(page).toHaveURL(/#\/monitor/);
  await expect(page.getByRole('heading', { name: 'Monitor', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Native sessions', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('zh');
  await expect(page.getByRole('heading', { name: '监控', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('en');
});

test('a terminal session appears with its project, turn state and transcript, then updates', async ({
  page,
}) => {
  test.skip(
    !process.env.CODEX_HOME || process.env.WORKSPACE_MONITOR_E2E !== '1',
    'Requires a dedicated CODEX_HOME shared by server and tests',
  );
  const project = await mkdtemp(join(tmpdir(), 'monitor-ui-')),
    id = randomUUID();
  const dir = join(process.env.CODEX_HOME!, 'sessions', 'monitor');
  const file = join(dir, 'rollout-' + id + '.jsonl');
  const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    jsonl(
      {
        type: 'session_meta',
        payload: { id, cwd: project, originator: 'codex_cli_rs', source: 'cli' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Monitor 原生 task' }],
        },
      },
      { type: 'event_msg', payload: { type: 'task_started' } },
    ),
  );
  const { token } = await (await page.request.get('/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  const registered = await (
    await page.request.post('/api/projects', {
      headers,
      data: { name: 'Monitor fixture', repoPath: project },
    })
  ).json();
  try {
    await page.goto('/#/monitor');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const sessions = page.getByRole('region', { name: 'Native sessions', exact: true });
    const row = sessions.getByRole('row').filter({ hasText: 'Monitor 原生 task' });
    await expect(row).toContainText('Monitor fixture');
    await expect(row).toContainText('Turn in progress');
    await expect(row).toContainText('Terminal CLI');
    await row.getByRole('button', { name: 'Monitor 原生 task', exact: true }).click();
    const detail = page.getByRole('region', { name: 'Session details', exact: true });
    await expect(detail).toContainText('codex resume ' + id);
    await expect(detail.locator('.monitor-transcript')).toContainText('Monitor 原生 task');
    await expect(page).toHaveURL(/#\/monitor\?native=[a-f0-9]{64}$/);
    const sessionUrl = page.url();
    await page.reload();
    await expect(detail.getByRole('heading', { name: 'Monitor 原生 task' })).toBeVisible();
    await sessions.getByLabel('Tool', { exact: true }).selectOption('claude');
    await expect(row).toHaveCount(0);
    await expect(detail).toBeVisible();
    await sessions.getByRole('button', { name: 'Show in session list' }).click();
    await expect(row).toBeVisible();
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(sessionUrl);
    await expect(detail).toBeVisible();
    await appendFile(file, jsonl({ type: 'event_msg', payload: { type: 'task_complete' } }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row).toContainText('Turn finished');
    const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
    expect(
      snapshot.tasks.filter((t: { projectId: string }) => t.projectId === registered.id),
    ).toEqual([]);
    await page.goto('/#/monitor?native=' + 'a'.repeat(64));
    await expect(page.getByRole('heading', { name: 'Session unavailable' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(/#\/monitor$/);
  } finally {
    await page.request.delete('/api/projects/' + registered.id, { headers });
    await rm(file, { force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('an unassigned session shows model, context use and alerts, and its folder can be registered', async ({
  page,
}) => {
  test.skip(
    !process.env.CODEX_HOME || process.env.WORKSPACE_MONITOR_E2E !== '1',
    'Requires a dedicated CODEX_HOME shared by server and tests',
  );
  const root = await mkdtemp(join(tmpdir(), 'monitor-register-')),
    project = join(root, 'loose 文件夹'),
    id = randomUUID();
  await mkdir(project);
  const dir = join(process.env.CODEX_HOME!, 'sessions', 'monitor');
  const file = join(dir, 'rollout-' + id + '.jsonl');
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    [
      { type: 'session_meta', payload: { id, cwd: project, source: 'cli' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Unassigned monitor task' }],
        },
      },
      { type: 'turn_context', payload: { model: 'gpt-e2e', cwd: project } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 64000 }, model_context_window: 256000 },
        },
      },
      { type: 'event_msg', payload: { type: 'error', message: 'fixture failure' } },
    ]
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  const { token } = await (await page.request.get('/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  try {
    await page.goto('/#/monitor');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const monitorNav = page.getByRole('button', { name: 'Monitor', exact: true });
    await expect(monitorNav.locator('.nav-count.alert')).toBeVisible();
    await expect(monitorNav).toHaveAccessibleDescription(/\d+ alerts/);
    const sessions = page.getByRole('region', { name: 'Native sessions', exact: true });
    const row = sessions.getByRole('row').filter({ hasText: 'Unassigned monitor task' });
    await expect(row).toContainText('Error recorded');
    await expect(row).toContainText('Unassigned');
    await row.getByRole('button', { name: 'Unassigned monitor task', exact: true }).click();
    const detail = page.getByRole('region', { name: 'Session details', exact: true });
    await expect(detail).toContainText('gpt-e2e');
    await expect(detail).toContainText('64k of 256k tokens (25%)');
    await detail.getByRole('button', { name: 'Register folder as project', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName('Load local project');
    await expect(dialog.getByLabel('Repository path', { exact: true })).toHaveValue(project);
    await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('loose 文件夹');
    await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'loose 文件夹', exact: true })).toBeVisible();
    await monitorNav.click();
    await expect(row).toContainText('loose 文件夹');
  } finally {
    const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
    for (const p of snapshot.projects.filter((p: { repoPath: string }) => p.repoPath === project))
      await page.request.delete('/api/projects/' + p.id, { headers });
    await rm(file, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('progress, questions waiting for an answer and desktop notifications for new alerts', async ({
  page,
}) => {
  test.skip(
    !process.env.CODEX_HOME ||
      !process.env.CLAUDE_CONFIG_DIR ||
      process.env.WORKSPACE_MONITOR_E2E !== '1',
    'Requires dedicated tool homes shared by server and tests',
  );
  // A stand-in Notification records what would be shown instead of opening system popups.
  await page.addInitScript(() => {
    const shown: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, body: options?.body });
      }
    }
    Object.assign(window, { Notification: FakeNotification, shownNotifications: shown });
  });
  const root = await mkdtemp(join(tmpdir(), 'monitor-progress-')),
    codexId = randomUUID(),
    claudeId = randomUUID();
  const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r) + '\n').join('');
  const codexFile = join(
    process.env.CODEX_HOME!,
    'sessions',
    'monitor',
    `rollout-${codexId}.jsonl`,
  );
  const claudeFile = join(
    process.env.CLAUDE_CONFIG_DIR!,
    'projects',
    '-progress',
    `${claudeId}.jsonl`,
  );
  await mkdir(join(process.env.CODEX_HOME!, 'sessions', 'monitor'), { recursive: true });
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-progress'), { recursive: true });
  await writeFile(
    codexFile,
    jsonl(
      { type: 'session_meta', payload: { id: codexId, cwd: root, source: 'cli' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Progress monitor task' }],
        },
      },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'p1',
          arguments: JSON.stringify({
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Build the feature', status: 'in_progress' },
            ],
          }),
        },
      },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'p1' } },
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: 'npm test' },
      },
    ),
  );
  const claudeRecord = (type: string, content: unknown[]) => ({
    type,
    sessionId: claudeId,
    cwd: root,
    entrypoint: 'cli',
    timestamp: new Date().toISOString(),
    message: { role: type, content, stop_reason: type === 'assistant' ? 'tool_use' : undefined },
  });
  try {
    await page.goto('/#/monitor');
    await page.getByRole('button', { name: 'Notifications off', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Notifications on', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const sessions = page.getByRole('region', { name: 'Native sessions', exact: true });
    const codexRow = sessions.getByRole('row').filter({ hasText: 'Progress monitor task' });
    await expect(codexRow).toContainText('Running exec');
    await expect(codexRow).toContainText('Plan 1/2 · Build the feature');

    // From now on the page counts as hidden, so new alerts are announced.
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      }),
    );
    await writeFile(
      claudeFile,
      jsonl(
        claudeRecord('user', [{ type: 'text', text: 'Claude question task' }]),
        claudeRecord('assistant', [
          { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} },
        ]),
      ),
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const claudeRow = sessions.getByRole('row').filter({ hasText: 'Claude question task' });
    await expect(claudeRow).toContainText('Waiting for your answer');
    const waiting = sessions.getByRole('button', { name: /Waiting for your answer/ });
    await waiting.click();
    await expect(waiting).toHaveAttribute('aria-pressed', 'true');
    await expect(codexRow).toHaveCount(0);
    const open = claudeRow.getByRole('button', { name: 'Claude question task', exact: true });
    await open.press('Enter');
    await expect(open).toHaveAttribute('aria-current', 'true');
    const detail = page.getByRole('region', { name: 'Session details', exact: true });
    await expect(detail.getByRole('heading', { name: 'Claude question task' })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(claudeRow).toContainText('Waiting for your answer');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(open).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { shownNotifications: unknown[] }).shownNotifications,
        ),
      )
      .toContainEqual({ title: 'Waiting for your answer', body: 'Claude question task' });
  } finally {
    await rm(codexFile, { force: true });
    await rm(claudeFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

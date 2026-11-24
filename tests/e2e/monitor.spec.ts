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
    await row.getByRole('button', { name: 'Inspect session', exact: true }).click();
    const detail = page.getByRole('region', { name: 'Session details', exact: true });
    await expect(detail).toContainText('codex resume ' + id);
    await expect(detail.locator('.monitor-transcript')).toContainText('Monitor 原生 task');
    await appendFile(file, jsonl({ type: 'event_msg', payload: { type: 'task_complete' } }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row).toContainText('Awaiting input');
    const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
    expect(
      snapshot.tasks.filter((t: { projectId: string }) => t.projectId === registered.id),
    ).toEqual([]);
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
    await row.getByRole('button', { name: 'Inspect session', exact: true }).click();
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

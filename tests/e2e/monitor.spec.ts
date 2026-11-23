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

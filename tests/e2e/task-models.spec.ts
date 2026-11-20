import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(page: Page) {
  const repo = await mkdtemp(join(tmpdir(), 'workspace-model-ui-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo });
  git(['init', '-b', 'main']);
  await writeFile(join(repo, 'README.md'), '# Model selector fixture');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial']);
  const token = (await (await page.request.get('/api/bootstrap')).json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  const response = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Model UI fixture', repoPath: repo },
  });
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  async function task(title: string, provider = 'mock') {
    const response = await page.request.post(`/api/projects/${project.id}/tasks`, {
      headers,
      data: { title, provider, description: 'Deterministic fixture' },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  return { project, task, headers };
}

test('Codex and Claude selectors submit model settings without starting paid inference', async ({
  page,
}) => {
  const { project, task } = await fixture(page);
  await task('Codex selector', 'codex');
  await task('Claude selector', 'claude');
  await page.route('**/api/models', (route) =>
    route.fulfill({
      json: {
        codex: [{ id: 'fixture-codex', label: 'Fixture Codex', efforts: ['low', 'high'] }],
        claude: [{ id: 'sonnet', label: 'sonnet', efforts: [] }],
        codexSource: 'local-cache',
      },
    }),
  );
  await page.route('**/api/tasks/*/runs', (route) =>
    route.fulfill({ status: 400, json: { error: 'Fixture: inference intentionally blocked' } }),
  );
  await page.goto(`/#/project?project=${project.id}`);
  await page.getByRole('button', { name: 'Run Codex selector', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('fixture-codex');
  await page.getByLabel('Reasoning effort').selectOption('high');
  await page.getByRole('checkbox', { name: /Run this real provider/ }).check();
  const codexRequest = page.waitForRequest(
    (request) => request.url().endsWith('/runs') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Queue execution', exact: true }).click();
  expect((await codexRequest).postDataJSON()).toMatchObject({
    model: 'fixture-codex',
    reasoningEffort: 'high',
    allowReal: true,
  });
  await expect(page.getByRole('status')).toContainText('inference intentionally blocked');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Run Claude selector', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('sonnet');
  await expect(page.getByLabel('Reasoning effort')).toHaveCount(0);
  await page.getByLabel('Model', { exact: true }).selectOption('__custom');
  await page.getByLabel('Custom model ID', { exact: true }).fill('fixture-claude');
  await page.getByRole('checkbox', { name: /Run this real provider/ }).check();
  const claudeRequest = page.waitForRequest(
    (request) => request.url().endsWith('/runs') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Queue execution', exact: true }).click();
  const body = (await claudeRequest).postDataJSON();
  expect(body.model).toBe('fixture-claude');
  expect(body.reasoningEffort).toBeUndefined();
});

test('task tree deletes a draft and reruns in a new session while preserving history', async ({
  page,
}) => {
  const { project, task, headers } = await fixture(page);
  await task('Disposable draft');
  const runnable = await task('Repeatable mock');
  await page.goto(`/#/project?project=${project.id}`);
  await page.getByRole('button', { name: 'Delete Disposable draft', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete task', exact: true }).click();
  await expect(page.getByRole('treeitem').filter({ hasText: 'Disposable draft' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run Repeatable mock', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue execution', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => {
      const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
      return snapshot.runs.filter(
        (run: { taskId: string; state: string }) =>
          run.taskId === runnable.id && run.state === 'completed',
      ).length;
    })
    .toBe(1);
  await page.goto(`/#/project?project=${project.id}`);
  await page.getByRole('button', { name: 'Actions for Repeatable mock', exact: true }).click();
  await page.getByRole('button', { name: 'Run / re-run with model…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('new isolated worktree');
  await page.getByRole('button', { name: 'Queue execution', exact: true }).click();
  await expect
    .poll(async () => {
      const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
      return snapshot.runs.filter(
        (run: { taskId: string; state: string }) =>
          run.taskId === runnable.id && run.state === 'completed',
      ).length;
    })
    .toBe(2);
  const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
  expect(
    snapshot.sessions.filter((session: { taskId: string }) => session.taskId === runnable.id),
  ).toHaveLength(2);
  await page.goto(`/#/project?project=${project.id}&task=${runnable.id}`);
  await expect(page.getByRole('heading', { name: 'Execution summary' })).toBeVisible();
  await expect(page.locator('.execution-summary')).toContainText('2 runs');
  await page.getByRole('button', { name: 'Load / refresh Codex · Claude history' }).click();
  await expect(page.locator('.execution-summary')).toContainText('native history · skipped');
  await page.goto(`/#/project?project=${project.id}`);
  await page.getByRole('button', { name: 'Delete Repeatable mock', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete task', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('session history');
});

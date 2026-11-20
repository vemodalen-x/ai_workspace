import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('import → task tree → isolated parallel runs → integration → approval → refresh', async ({
  page,
}) => {
  const repo = await mkdtemp(join(tmpdir(), 'workspace-e2e-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  await writeFile(join(repo, 'README.md'), '# E2E fixture');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial']);
  const title = `CV-Agent-${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project', exact: true }).last().click();
  await page.getByLabel('Project name').fill(title);
  await page.getByLabel('Repository path').fill(repo);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  async function createTask(name: string, prompt: string, integration = false) {
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByLabel('Task title').fill(name);
    await page.getByRole('dialog').getByLabel('Provider', { exact: true }).selectOption('mock');
    await page.getByLabel('Description', { exact: true }).fill(prompt);
    if (integration) {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox', { name: 'Task A: Backend', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Task B: Frontend', exact: true }).check();
      await page.getByLabel('Build an integration worktree').check();
    }
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await createTask('Task A: Backend', 'Backend mock fixture');
  await createTask('Task B: Frontend', 'Frontend mock fixture');
  await createTask('Task C: Integration', '[validate]', true);
  await page.getByRole('button', { name: 'Queue draft tasks', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Queue tasks', exact: true }).click();
  await expect(page.getByRole('treeitem').filter({ hasText: 'Task C: Integration' })).toContainText(
    'completed',
    { timeout: 30000 },
  );
  await page.getByRole('treeitem').filter({ hasText: 'Task C: Integration' }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.locator('.diff-view')).toContainText('validation-report.json');
  await page.getByRole('button', { name: 'Preview merge', exact: true }).click();
  await page.getByRole('button', { name: 'Review approval', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Action completed');
  expect(JSON.parse(await readFile(join(repo, 'validation-report.json'), 'utf8')).passed).toBe(
    true,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Run history', exact: true }).click();
  await expect(page.locator('.run-history')).toContainText('completed');
});

test('keyboard opens search and task settings dialog is accessible', async ({ page }) => {
  const repo = await mkdtemp(join(tmpdir(), 'workspace-keyboard-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo });
  git(['init', '-b', 'main']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture',
  ]);
  const { token } = await (await page.request.get('/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  const project = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Keyboard fixture', repoPath: repo },
  });
  expect(project.ok()).toBeTruthy();
  const { id } = await project.json();
  const task = await page.request.post('/api/projects/' + id + '/tasks', {
    headers,
    data: { title: 'Keyboard draft' },
  });
  expect(task.ok()).toBeTruthy();
  await page.goto('/#/project?project=' + id);
  await page.getByLabel('Search workspace').press('ControlOrMeta+k');
  await expect(page.getByLabel('Search workspace')).toBeFocused();
  await page.getByRole('treeitem').filter({ hasText: 'Keyboard draft' }).click();
  await page.getByRole('button', { name: 'Configure task', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('focus capture → clarify → project context → refresh without starting an agent', async ({
  page,
}) => {
  const repo = await mkdtemp(join(tmpdir(), 'workspace-focus-e2e-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  await writeFile(join(repo, 'README.md'), '# Focus fixture');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project', exact: true }).last().click();
  const name = `Focus-${Date.now()}`;
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('Repository path').fill(repo);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByRole('button', { name: 'Focus inbox', exact: true }).click();
  await page.locator('.focus-capture select').selectOption({ label: name });
  await page.getByLabel('Quick capture').fill('Improve inference latency');
  await page.getByRole('button', { name: 'Capture draft', exact: true }).click();
  const row = page.locator('.attention-row').filter({ hasText: 'Improve inference latency' });
  await expect(row).toContainText('clarify');
  await row.getByRole('button', { name: 'Clarify task', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Profile the inference path');
  await page
    .getByLabel('Acceptance criteria')
    .fill('Report measured p50 and p95 with reproducible inputs');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await page.getByRole('button', { name: 'Focus inbox', exact: true }).click();
  await page.locator('.focus-capture select').selectOption({ label: name });
  await expect(row).toContainText('Review and launch');
  await page.locator('.focus-context summary').click();
  await page.getByLabel('Working agreements').fill('Do not change the model weights.');
  await page.getByRole('button', { name: 'Save project context', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Project context saved');
  await page.reload();
  await page.locator('.focus-capture select').selectOption({ label: name });
  await page.locator('.focus-context summary').click();
  await expect(page.getByLabel('Working agreements')).toHaveValue(
    'Do not change the model weights.',
  );
  const token = (await (await page.request.get('/api/bootstrap')).json()).token;
  const snapshot = await (
    await page.request.get('/api/snapshot', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const project = snapshot.projects.find((p: { name: string }) => p.name === name);
  expect(
    snapshot.runs.filter((r: { projectId: string }) => r.projectId === project.id),
  ).toHaveLength(0);
});

test('compute fleet provides node search, a real refresh action and independently loaded history', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compute nodes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compute fleet' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  await page.getByRole('button', { name: 'Show history', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Node telemetry history' })).toBeVisible();
  await page.getByLabel('Find server').fill('definitely-no-such-server-fixture');
  await expect(page.getByText('No servers match this filter.')).toBeVisible();
});

test('navigate to independent experiments and return to the resource fleet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compute nodes', exact: true }).click();
  await page.getByRole('button', { name: 'Experiments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compare experiment runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Compute nodes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'GPU capacity' })).toBeVisible();
  await expect(page.getByLabel('Find server')).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../../packages/git-manager/index.ts';

test('create, review, execute and compare command trial attempts', async ({ page }) => {
  const repo = await mkdtemp(join(tmpdir(), 'command-trial-e2e-'));
  await git(repo, ['init', '-b', 'main']);
  await writeFile(
    join(repo, 'measure.cjs'),
    "for (const step of [1,2]) console.log('WORKSPACE_METRIC '+JSON.stringify({name:'loss',unit:'',step,value:1/step})); console.log('Finished measurement');",
  );
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=test@localhost',
    'commit',
    '-m',
    'Measure',
  ]);
  const sha = await git(repo, ['rev-parse', 'HEAD']);
  const token = (await (await page.request.get('/api/bootstrap')).json()).token;
  const project = await page.request.post('/api/projects', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Trial fixture', repoPath: repo },
  });
  expect(project.ok()).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/experiments');
  await page.getByLabel('Project filter').selectOption((await project.json()).id);
  await page.getByRole('button', { name: 'New trial' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Trial name').fill('Measure loss');
  await dialog.getByLabel('Command (JSON argv)').fill('["node","measure.cjs"]');
  await dialog.getByLabel('Experiment group').fill('Training');
  await dialog.getByLabel('Random seed').fill('42');
  await dialog.getByRole('button', { name: 'Save trial' }).click();
  await expect(page.getByLabel('Execution attempt')).toBeDisabled();
  await page.getByRole('button', { name: 'Run trial' }).click();
  await expect(dialog).toContainText(sha);
  await expect(dialog).toContainText('measure.cjs');
  await dialog.getByRole('button', { name: 'Queue attempt' }).click();
  const panel = page.getByRole('region', { name: 'Local command trials' });
  await expect(panel.locator('.badge')).toHaveText('completed', { timeout: 25000 });
  await expect(panel.getByRole('img', { name: 'loss by step' })).toBeVisible();
  await panel.getByText('Command output', { exact: true }).click();
  await expect(panel).toContainText('Finished measurement');
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export attempt JSON' }).click();
  const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(report.trial.commit).toBe(sha);
  expect(report.trial.argv).toEqual(['node', 'measure.cjs']);
  expect(report.attempt.exitCode).toBe(0);
  expect(report.output.metrics.at(-1).value).toBe(0.5);
  expect(report.output.log).toContain('Finished measurement');
  await panel.getByRole('button', { name: 'Retry trial' }).click();
  await dialog.getByRole('button', { name: 'Queue attempt' }).click();
  await expect(panel.getByLabel('Execution attempt').locator('option')).toHaveCount(2);
  await expect(panel.getByRole('img', { name: 'loss by step' })).toBeVisible();
  await panel.getByLabel('Compare attempt').selectOption({ index: 1 });
  await expect(panel).toContainText('Reference (amber) · 0.5 at step 2');
  await page.reload();
  await expect(panel.getByLabel('Execution attempt').locator('option')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('img', { name: 'loss by step' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('attach existing Claude history, watch appends, reload and detach without executing', async ({
  page,
}) => {
  test.skip(
    !process.env.CLAUDE_CONFIG_DIR || process.env.WORKSPACE_EXTERNAL_SESSION_E2E !== '1',
    'Requires a dedicated CLAUDE_CONFIG_DIR passed to both server and tests',
  );
  const root = await mkdtemp(join(tmpdir(), 'external-session-ui-'));
  const id = randomUUID();
  const sourceDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', `test-${id}`);
  await mkdir(sourceDir, { recursive: true });
  const source = join(sourceDir, `${id}.jsonl`);
  const line = (text: string) =>
    JSON.stringify({
      sessionId: id,
      type: 'user',
      cwd: '/original/terminal',
      message: { content: text },
    }) + '\n';
  await writeFile(source, line('History from original terminal'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-b', 'main');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture',
  );
  const { token } = await (await page.request.get('/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  const response = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Session attachment fixture', repoPath: root },
  });
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  try {
    await page.goto('/#/project?project=' + project.id);
    const region = page.getByRole('region', { name: 'Attached Claude sessions' });
    await region.getByLabel('Claude session ID', { exact: true }).fill(id);
    await region.getByRole('button', { name: 'Attach session', exact: true }).click();
    await expect(region.getByLabel('Session transcript')).toContainText(
      'History from original terminal',
    );
    await expect(region).toContainText('/original/terminal');
    await appendFile(source, line('New message from original terminal'));
    await expect(region.getByLabel('Session transcript')).toContainText(
      'New message from original terminal',
      { timeout: 12000 },
    );
    await page.reload();
    await expect(region.getByLabel('Attached session', { exact: true })).toContainText(id);
    const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
    expect(snapshot.runs.filter((r: { projectId: string }) => r.projectId === project.id)).toEqual(
      [],
    );
    expect(
      snapshot.sessions.filter((s: { projectId: string }) => s.projectId === project.id),
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await rm(source);
    await expect(region.getByRole('alert')).toContainText('History unavailable', {
      timeout: 12000,
    });
    await writeFile(source, line('Restored source'));
    await expect(region.getByLabel('Session transcript')).toContainText('Restored source', {
      timeout: 12000,
    });
    await region.getByRole('button', { name: 'Detach session', exact: true }).click();
    await region.getByRole('button', { name: 'Confirm detach', exact: true }).click();
    await expect(region).toContainText('No attached sessions.');
    expect(await readFile(source, 'utf8')).toContain('Restored source');
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
});

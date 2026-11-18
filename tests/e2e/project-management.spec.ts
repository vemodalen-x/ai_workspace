import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('browse an existing folder, reopen duplicates, remove registration and reload without touching files', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-project-ui-'));
  const folder = join(root, 'existing 中文');
  await mkdir(folder);
  await writeFile(join(folder, 'keep.txt'), 'Original --command 中文');
  await writeFile(join(folder, 'AGENTS.md'), '# Existing project instructions');
  try {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('en');
    await page.getByRole('button', { name: 'Import project', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Repository path', { exact: true }).fill(root);
    await dialog.getByRole('button', { name: 'Browse local folders', exact: true }).click();
    await dialog.getByRole('button', { name: 'existing 中文', exact: true }).click();
    await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(dialog.getByLabel('Repository path', { exact: true })).toHaveValue(folder);
    await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('existing 中文');
    await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'existing 中文', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeDisabled();
    const firstHash = await page.evaluate(() => location.hash);
    const history = page.getByRole('region', { name: 'Local tool history' });
    await expect(history).toContainText('No matching readable sessions found.');
    await history.getByText('Available configuration and instructions', { exact: true }).click();
    await history
      .locator('summary')
      .filter({ hasText: join(folder, 'AGENTS.md') })
      .click();
    await expect(history).toContainText('# Existing project instructions');
    await page.getByRole('button', { name: 'Import project', exact: true }).last().click();
    await dialog.getByLabel('Project name', { exact: true }).fill('Duplicate');
    await dialog.getByLabel('Repository path', { exact: true }).fill(folder);
    await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(firstHash);
    await page.getByRole('button', { name: 'Remove existing 中文', exact: true }).click();
    await expect(dialog).toContainText('Local files and Codex / Claude Code data stay untouched.');
    await dialog.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(page.locator('.project-nav')).not.toContainText('existing 中文');
    expect(await readFile(join(folder, 'keep.txt'), 'utf8')).toBe('Original --command 中文');
    await page.getByRole('button', { name: 'Import project', exact: true }).first().click();
    await dialog.getByLabel('Project name', { exact: true }).fill('Reload');
    await dialog.getByLabel('Repository path', { exact: true }).fill(folder);
    await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'existing 中文', exact: true })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(firstHash);
    await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('zh');
    await expect(page.getByRole('region', { name: '本机工具历史' })).toBeVisible();
    await expect(page.getByRole('button', { name: '移除项目', exact: true })).toBeVisible();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid folder errors keep user input', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('zh');
  await page.getByRole('button', { name: '导入项目', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('项目名称', { exact: true }).fill('Original input');
  await dialog.getByLabel('仓库路径', { exact: true }).fill('/workspace-does-not-exist-00000');
  await dialog.getByRole('button', { name: '选择本地文件夹', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('本地文件夹不存在');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('Original input');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
});

test('both providers and configuration statuses display in Chinese and English without translating transcript text', async ({
  page,
}) => {
  await page.route('**/api/snapshot', async (route) => {
    const snapshot = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...snapshot,
        projects: [
          {
            id: 'native-ui',
            name: 'Existing folder',
            repoPath: '/existing/中文',
            baseBranch: '',
            executionReady: false,
            archived: false,
            concurrency: 2,
          },
        ],
        tasks: [],
      },
    });
  });
  await page.route('**/api/projects/native-ui/local-history?refresh=true', (route) =>
    route.fulfill({
      json: {
        projectPath: '/existing/中文',
        configs: [{ path: '/existing/中文/AGENTS.md', scope: 'project', state: 'missing' }],
        sources: [
          { provider: 'codex', path: '/home/tools/codex/sessions', state: 'available', skipped: 0 },
          { provider: 'claude', path: '/home/tools/claude/projects', state: 'partial', skipped: 1 },
        ],
        sessions: [
          {
            id: 'codex-record',
            provider: 'codex',
            providerSessionId: 'codex-original-id',
            cwd: '/existing/中文',
            modifiedAt: '2026-11-18T00:00:00Z',
            bytes: 12,
          },
          {
            id: 'claude-record',
            provider: 'claude',
            providerSessionId: 'claude-original-id',
            cwd: '/existing/中文',
            modifiedAt: '2026-11-18T00:00:00Z',
            bytes: 12,
          },
        ],
      },
    }),
  );
  await page.route('**/api/projects/native-ui/local-history/*', (route) =>
    route.fulfill({
      json: {
        entries: [{ role: 'assistant', text: 'Original 中文 npm test --flag const ready = true;' }],
        truncated: false,
        skipped: 0,
      },
    }),
  );
  await page.goto('/#/project?project=native-ui');
  const language = page.getByRole('combobox', { name: 'Language / 语言' }).last();
  for (const locale of ['en', 'zh']) {
    await language.selectOption(locale);
    const region = page.getByRole('region', {
      name: locale === 'zh' ? '本机工具历史' : 'Local tool history',
    });
    for (const provider of ['codex', 'claude']) {
      await region
        .getByLabel(locale === 'zh' ? '工具' : 'Tool', { exact: true })
        .selectOption(provider);
      await region
        .getByLabel(locale === 'zh' ? '本机会话' : 'Local sessions', { exact: true })
        .selectOption(provider + '-record');
      await expect(
        region.getByLabel(locale === 'zh' ? '本机会话记录' : 'Local session transcript'),
      ).toContainText('Original 中文 npm test --flag const ready = true;');
    }
  }
});

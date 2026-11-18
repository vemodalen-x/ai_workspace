import { test, expect, type Page } from '@playwright/test';
import { fleet, runs, artifacts } from '../../examples/visual-review/data.ts';
import { taskInput } from '../../packages/shared/index.ts';

const rawTitle = 'ready 中文 / Original English';
async function fixture(page: Page) {
  await page.route('**/api/snapshot', async (route) => {
    const snapshot = await (await route.fetch()).json();
    const task = {
      ...taskInput.parse({
        title: rawTitle,
        description: 'Keep --command 中文 unchanged',
        criteria: 'Original criteria',
      }),
      id: 'i18n-task',
      projectId: 'sample-project',
      state: 'draft',
      createdAt: new Date().toISOString(),
    };
    await route.fulfill({
      json: {
        ...snapshot,
        ...fleet,
        projects: [
          {
            id: 'sample-project',
            name: 'ready',
            repoPath: '/tmp/原始/path',
            concurrency: 2,
            archived: false,
          },
        ],
        tasks: [task],
        sessions: [],
        runs,
        artifacts,
        approvals: [],
        workspaces: [],
        trials: [],
        attempts: [],
        briefing: {
          generatedAt: new Date().toISOString(),
          running: 0,
          items: [
            {
              id: 'attention',
              kind: 'clarify',
              taskId: task.id,
              projectId: task.projectId,
              title: rawTitle,
              reason:
                'Define a concrete outcome and observable acceptance criteria before delegating.',
              action: 'Clarify task',
              priority: 50,
            },
          ],
          review: { since: '', completed: 0, commandPassed: 0, unverified: 0, failed: 0 },
        },
      },
    });
  });
  await page.route('**/api/projects/sample-project/external-sessions', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/tasks/i18n-task/summary?history=false', (route) =>
    route.fulfill({ json: { runs: [], histories: [], generatedAt: new Date().toISOString() } }),
  );
}
const language = (page: Page) => page.getByRole('combobox', { name: 'Language / 语言' }).last();

test('first visit follows Chinese browser language; selection survives reload and new pages', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'zh-TW' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(language(page)).toHaveValue('zh');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page).toHaveTitle('AI 智能体工作区');
  await language(page).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Focus inbox', exact: true })).toBeVisible();
  await page.reload();
  await expect(language(page)).toHaveValue('en');
  const second = await context.newPage();
  await second.goto('/#/settings');
  await expect(language(second)).toHaveValue('en');
  await context.close();
});

test('unsupported language and corrupt preference fall back to English; blocked storage still allows switching', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('aw.locale', '"invalid"'));
  await page.goto('/');
  await expect(language(page)).toHaveValue('en');
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('Storage blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('Storage blocked');
    };
  });
  await page.reload();
  await language(page).selectOption('zh');
  await expect(page.getByRole('heading', { name: '待办收件箱', exact: true })).toBeVisible();
  await context.close();
});

test('switching preserves routes, search, task form values and backend errors', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/#/project?project=sample-project&task=i18n-task');
  await expect(page.getByRole('heading', { name: rawTitle, exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title', { exact: true }).fill('User 输入 --flag');
  await dialog.getByLabel('Description', { exact: true }).fill('npm run test\n原始内容');
  const hash = await page.evaluate(() => location.hash);
  await language(page).selectOption('zh');
  await expect(dialog.getByLabel('任务标题', { exact: true })).toHaveValue('User 输入 --flag');
  await expect(dialog.getByLabel('描述', { exact: true })).toHaveValue('npm run test\n原始内容');
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('搜索工作区')).toBeFocused();
  await page.getByLabel('搜索工作区').fill('原始查询');
  await language(page).selectOption('en');
  await expect(page.getByLabel('Search workspace')).toHaveValue('原始查询');
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 409, json: { error: 'Repository already imported' } }),
  );
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  await dialog.getByLabel('Project name').fill('Raw title');
  await dialog.getByLabel('Repository path').fill('/tmp/raw/path');
  await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Repository already imported');
  await language(page).selectOption('zh');
  await expect(page.getByRole('status')).toContainText('仓库已导入');
});

for (const locale of ['en', 'zh'] as const) {
  test(`${locale}: all workspace views and narrow layouts retain navigation, data and actions`, async ({
    page,
  }) => {
    await fixture(page);
    await page.goto('/');
    await language(page).selectOption(locale);
    for (const width of [1500, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [view, heading] of [
        ['focus', locale === 'zh' ? '待办收件箱' : 'Focus inbox'],
        ['dashboard', locale === 'zh' ? '工作区概览' : 'Workspace overview'],
        ['project', 'ready'],
        ['sessions', locale === 'zh' ? '会话控制台' : 'Session console'],
        ['experiments', locale === 'zh' ? '实验' : 'Experiments'],
        ['compute', locale === 'zh' ? '计算节点集群' : 'Compute fleet'],
        ['activity', locale === 'zh' ? '活动时间线' : 'Activity timeline'],
        ['settings', locale === 'zh' ? '设置与服务提供方' : 'Settings & providers'],
      ]) {
        await page.goto(`/#/${view}?project=sample-project`);
        await expect(
          page.getByRole('heading', { name: heading, exact: true }).first(),
        ).toBeVisible();
        await expect(language(page)).toBeVisible();
        const selectorBounds = await language(page).boundingBox();
        const headerBounds = await page.locator('.topbar').boundingBox();
        expect(selectorBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
        expect(selectorBounds!.y + selectorBounds!.height).toBeLessThanOrEqual(
          headerBounds!.y + headerBounds!.height,
        );
        if (view === 'compute')
          await page.screenshot({ path: `artifacts/i18n/${locale}-${width}.png` });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${locale}/${view}/${width}`,
        ).toBe(true);
      }
    }
    await page.goto('/#/focus');
    await expect(page.locator('.attention-body h3')).toHaveText(rawTitle);
    await expect(page.locator('.attention-body p')).toHaveText(
      locale === 'zh'
        ? '委派前请明确具体目标及可观测的验收标准。'
        : 'Define a concrete outcome and observable acceptance criteria before delegating.',
    );
  });
}

test('server unavailable still offers language switching and localized errors', async ({
  page,
}) => {
  await page.route('**/api/bootstrap', (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto('/');
  await language(page).selectOption('zh');
  await expect(page.getByRole('heading', { name: '本地服务器不可用' })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
  await expect(page.getByText('无法连接本地服务器', { exact: true })).toBeVisible();
});

test('Chinese interface creates, runs and inspects a real Mock task', async ({ page }) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const repo = await mkdtemp(join(tmpdir(), 'workspace-i18n-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'Original English 中文');
  git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial');
  await page.goto('/');
  await language(page).selectOption('zh');
  await page.getByRole('button', { name: '导入项目', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('项目名称').fill('中文项目 Original');
  await dialog.getByLabel('仓库路径').fill(repo);
  await dialog.getByRole('button', { name: '导入项目', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await dialog.getByLabel('任务标题', { exact: true }).fill('Task A: Backend 原始标题');
  await dialog.getByLabel('描述', { exact: true }).fill('Backend mock fixture');
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('button', { name: '将草稿任务加入队列', exact: true }).click();
  await language(page).selectOption('en');
  await expect(dialog).toContainText('Queue 1 tasks?');
  await language(page).selectOption('zh');
  await dialog.getByRole('button', { name: '任务入队', exact: true }).click();
  const row = page.getByRole('treeitem').filter({ hasText: 'Task A: Backend 原始标题' });
  await expect(row).toContainText('已完成', { timeout: 30000 });
  await row.click();
  await page.getByRole('button', { name: '审查变更', exact: true }).click();
  await expect(page.locator('.diff-view')).toContainText('Backend mock fixture');
  await language(page).selectOption('en');
  await expect(page.locator('.diff-view')).toContainText('Backend mock fixture');
  await expect(page.locator('.console-header')).toContainText('Task A: Backend 原始标题');
});

test('attached-session UI translates while source paths and transcript remain original', async ({
  page,
}) => {
  await fixture(page);
  const raw = 'ready\n中文 Original English\nconst result = "failed";\nnpm run test -- --flag';
  await page.route('**/api/projects/sample-project/external-sessions', (route) =>
    route.fulfill({
      json: [
        {
          id: 'external-id',
          providerSessionId: 'original-provider-id',
          sourceCwd: '/原始/ready/path',
        },
      ],
    }),
  );
  await page.route('**/api/external-sessions/external-id/output', (route) =>
    route.fulfill({
      json: {
        modifiedAt: new Date().toISOString(),
        bytes: 100,
        truncated: false,
        skipped: 0,
        entries: [{ role: 'assistant', text: raw }],
      },
    }),
  );
  await page.goto('/#/project?project=sample-project');
  for (const locale of ['zh', 'en']) {
    await language(page).selectOption(locale);
    await expect(page.locator('.external-transcript pre')).toHaveText(raw);
    await expect(page.locator('.external-sessions')).toContainText('/原始/ready/path');
    await expect(page.locator('.external-transcript strong')).toHaveText(
      locale === 'zh' ? '助手' : 'assistant',
    );
  }
});

test('translated filters retain machine values and state styling across switches and reloads', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/#/focus');
  await language(page).selectOption('zh');
  const filter = page.getByRole('combobox', { name: '筛选待处理事项' });
  await filter.selectOption({ label: '完善' });
  await expect(filter).toHaveValue('clarify');
  await expect(page.locator('.attention-row')).toHaveCount(1);
  await expect(page.locator('.attention-row')).toHaveClass(/attention-clarify/);
  await filter.selectOption({ label: '就绪' });
  await expect(filter).toHaveValue('ready');
  await expect(page.locator('.attention-row')).toHaveCount(0);
  await language(page).selectOption('en');
  await expect(page.getByLabel('Filter attention')).toHaveValue('ready');
  await page.reload();
  await page.getByLabel('Filter attention').selectOption('clarify');
  await expect(page.locator('.attention-row')).toHaveCount(1);
  await page.goto('/#/compute');
  await language(page).selectOption('zh');
  await expect(page.locator('.fleet-node.fleet-stale')).toHaveCount(1);
  await expect(page.locator('.fleet-node.fleet-offline')).toHaveCount(1);
});

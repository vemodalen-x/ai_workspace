import { test, expect } from '@playwright/test';

test('history disclosures support keyboard, search recovery and refresh in both languages', async ({
  page,
}) => {
  await page.route('**/api/snapshot', async (route) => {
    const snapshot = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...snapshot,
        projects: [
          {
            id: 'ux-history',
            name: 'UX fixture',
            repoPath: '/ux',
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
  await page.route('**/api/projects/ux-history/local-history?refresh=true', (route) =>
    route.fulfill({ json: { configs: [], sources: [], sessions: [] } }),
  );
  await page.route('**/api/projects/ux-history/history-task-tree?refresh=true', (route) =>
    route.fulfill({
      json: {
        nodes: [
          {
            id: 'session',
            parentId: null,
            sessionId: 'source',
            provider: 'codex',
            kind: 'session',
            title: 'Raw session',
            description: '',
            state: 'recorded',
          },
          {
            id: 'request',
            parentId: 'session',
            sessionId: 'source',
            provider: 'codex',
            kind: 'request',
            title: '原文 npm test --flag',
            description: '',
            state: 'recorded',
          },
        ],
        truncated: false,
        skipped: 0,
        unavailableSessions: 0,
      },
    }),
  );
  await page.goto('/#/project?project=ux-history');
  for (const locale of ['en', 'zh']) {
    await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption(locale);
    const region = page.getByRole('region', {
      name: locale === 'en' ? 'History task tree' : '历史任务树',
      exact: true,
    });
    const toggle = region.locator('button[aria-expanded]').first();
    const request = region.getByRole('listitem', { name: '原文 npm test --flag', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(request).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(request).toBeVisible();
    await region
      .getByRole('button', {
        name: locale === 'en' ? 'Refresh task tree' : '刷新任务树',
        exact: true,
      })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(request).toBeHidden();
    const search = region.getByRole('textbox');
    await search.fill('  npm test  ');
    await expect(request).toBeVisible();
    await search.fill('no-such-task');
    await expect(region).toContainText(
      locale === 'en' ? 'No matching history tasks' : '没有匹配的历史任务',
    );
    await region
      .getByRole('button', { name: locale === 'en' ? 'Clear search' : '清除搜索', exact: true })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1500, height: 1000 });
  }
});

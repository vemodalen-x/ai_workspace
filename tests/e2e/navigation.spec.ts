import { test, expect } from '@playwright/test';
import { runs, artifacts } from '../../examples/visual-review/data.ts';

test('deep links, browser back and refresh restore view and search', async ({ page }) => {
  await page.goto('/#/experiments?q=retained');
  await expect(page.getByRole('heading', { name: 'Experiments', exact: true })).toBeVisible();
  await expect(page.getByLabel('Search workspace')).toHaveValue('retained');
  await expect(page.getByLabel('Toggle inspector')).toBeHidden();
  await page.getByRole('button', { name: 'Compute nodes', exact: true }).click();
  await page.getByLabel('Find server').fill('saved-node-filter');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Experiments', exact: true })).toBeVisible();
  await expect(page.getByLabel('Search workspace')).toHaveValue('retained');
  await page.reload();
  await expect(page.getByLabel('Search workspace')).toHaveValue('retained');
  await page.getByRole('button', { name: 'Compute nodes', exact: true }).click();
  await expect(page.getByLabel('Find server')).toHaveValue('saved-node-filter');
});

test('sample experiment baseline survives refresh and history growth; missing baseline requires a choice', async ({
  page,
}) => {
  let expanded = false,
    missing = false;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.projects = [{ id: 'sample-project', name: 'Fixture project', archived: false }];
    data.tasks = [];
    data.sessions = [];
    data.artifacts = artifacts;
    data.runs = missing
      ? runs.filter((r) => r.id !== 'fp16-ref')
      : expanded
        ? [
            ...Array.from({ length: 25 }, (_, i) => ({
              ...runs[0],
              id: 'new-' + i,
              createdAt: new Date(2026, 11, i + 1).toISOString(),
            })),
            ...runs,
          ]
        : runs;
    await route.fulfill({ json: data });
  });
  await page.goto('/#/experiments');
  await page.getByLabel('Baseline run').selectOption('fp16-ref');
  await page.getByLabel('Metric and unit').selectOption(JSON.stringify(['throughput', 'images/s']));
  await page.getByLabel('Baseline run').selectOption('fp16-ref');
  await page.reload();
  await expect(page.getByLabel('Baseline run')).toHaveValue('fp16-ref');
  await expect(page.getByLabel('Metric and unit')).toHaveValue(
    JSON.stringify(['throughput', 'images/s']),
  );
  expanded = true;
  await page.reload();
  await expect(page.getByLabel('Baseline run')).toHaveValue('fp16-ref');
  await expect(page.locator('.delta-row')).toHaveCount(21);
  missing = true;
  await page.reload();
  await expect(
    page.getByText('The saved baseline has no available reading.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Baseline run')).toHaveValue('');
  await page.getByLabel('Baseline run').selectOption('int8-cal');
  await expect(page.getByLabel('Baseline run')).toHaveValue('int8-cal');
});

test('narrow viewport exposes experiments navigation and empty-state action without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/experiments');
  await expect(page.getByRole('button', { name: 'Experiments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create experiment task' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

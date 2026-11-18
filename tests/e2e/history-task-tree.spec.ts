import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

test('loading a folder automatically generates both provider task trees, refreshes without duplicates and opens source history', async ({
  page,
}) => {
  test.skip(
    !process.env.CODEX_HOME ||
      !process.env.CLAUDE_CONFIG_DIR ||
      process.env.WORKSPACE_HISTORY_TREE_E2E !== '1',
    'Requires dedicated provider homes shared by server and tests',
  );
  const project = await mkdtemp(join(tmpdir(), 'history-tree-ui-')),
    id = randomUUID();
  const codex = join(process.env.CODEX_HOME!, 'sessions', 'tree-' + id + '.jsonl'),
    claudeDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'tree-' + id),
    claude = join(claudeDir, id + '.jsonl');
  const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await mkdir(join(process.env.CODEX_HOME!, 'sessions'), { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    codex,
    jsonl(
      { type: 'session_meta', payload: { id, cwd: project } },
      {
        type: 'response_item',
        ordinal: 1,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Implement 原始 Codex task' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Validate --flag', status: 'pending' }] }),
        },
      },
    ),
  );
  await writeFile(
    claude,
    jsonl(
      {
        type: 'user',
        uuid: 'claude-user',
        sessionId: id,
        cwd: project,
        message: { content: 'Original Claude task' },
      },
      {
        type: 'assistant',
        sessionId: id,
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'Check 中文 plan', status: 'completed' }] },
            },
          ],
        },
      },
    ),
  );
  const { token } = await (await page.request.get('/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  const registered = await (
    await page.request.post('/api/projects', {
      headers,
      data: { name: 'History tree fixture', repoPath: project },
    })
  ).json();
  try {
    await page.goto('/#/project?project=' + registered.id);
    const tree = page.getByRole('region', { name: 'History task tree', exact: true });
    await expect(
      tree.getByRole('treeitem', { name: 'Implement 原始 Codex task', exact: true }),
    ).toBeVisible();
    await expect(
      tree.getByRole('treeitem', { name: 'Original Claude task', exact: true }),
    ).toBeVisible();
    await expect(
      tree.getByRole('treeitem', { name: 'Validate --flag', exact: true }),
    ).toContainText('Plan marked pending');
    await expect(
      tree.getByRole('treeitem', { name: 'Check 中文 plan', exact: true }),
    ).toContainText('Plan marked complete');
    const count = await tree.getByRole('treeitem').count();
    await tree.getByRole('button', { name: 'Refresh task tree', exact: true }).click();
    await expect(tree.getByRole('treeitem')).toHaveCount(count);
    await tree
      .getByRole('button', { name: 'View source for Implement 原始 Codex task', exact: true })
      .click();
    await expect(page.getByLabel('Local session transcript', { exact: true })).toContainText(
      'Implement 原始 Codex task',
    );
    await appendFile(
      codex,
      jsonl({
        type: 'response_item',
        ordinal: 2,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'New incremental request' }],
        },
      }),
    );
    await expect(
      tree.getByRole('treeitem', { name: 'New incremental request', exact: true }),
    ).toBeVisible({ timeout: 25000 });
    await page.reload();
    await expect(
      tree.getByRole('treeitem', { name: 'New incremental request', exact: true }),
    ).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Language / 语言' }).last().selectOption('zh');
    const chinese = page.getByRole('region', { name: '历史任务树', exact: true });
    await expect(
      chinese.getByRole('treeitem', { name: 'Validate --flag', exact: true }),
    ).toContainText('计划标记为待处理');
    await chinese.getByLabel('搜索历史任务', { exact: true }).fill('Check 中文');
    await expect(
      chinese.getByRole('treeitem', { name: 'Check 中文 plan', exact: true }),
    ).toBeVisible();
    await expect(
      chinese.getByRole('treeitem', { name: 'Implement 原始 Codex task', exact: true }),
    ).toHaveCount(0);
    const snapshot = await (await page.request.get('/api/snapshot', { headers })).json();
    expect(
      snapshot.tasks.filter((t: { projectId: string }) => t.projectId === registered.id),
    ).toEqual([]);
    expect(
      snapshot.runs.filter((r: { projectId: string }) => r.projectId === registered.id),
    ).toEqual([]);
  } finally {
    await page.request.delete('/api/projects/' + registered.id, { headers });
    await rm(project, { recursive: true, force: true });
    await rm(codex, { force: true });
    await rm(claudeDir, { recursive: true, force: true });
  }
});

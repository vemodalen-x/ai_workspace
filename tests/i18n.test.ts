import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../apps/web/src/locales/en.json' with { type: 'json' };
import zh from '../apps/web/src/locales/zh.json' with { type: 'json' };
import {
  browserLocale,
  errorText,
  getLocale,
  setLocale,
  translate,
  uiMessage,
} from '../apps/web/src/i18n.ts';

test('locale negotiation uses the browser primary language and English fallback', () => {
  for (const code of ['zh', 'zh-CN', 'zh-TW', 'ZH-hant-HK'])
    assert.equal(browserLocale([code]), 'zh');
  for (const codes of [[], ['en-US'], ['fr-FR', 'zh-CN'], ['ja-JP']])
    assert.equal(browserLocale(codes), 'en');
});

test('both catalogs contain the same nonempty messages and interpolation values', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(en[key].trim() && zh[key].trim(), key);
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
  }
  const raw = '中文 English <script> $& {title}';
  assert.equal(translate('zh', 'Run {title}', { title: raw }), '运行 ' + raw);
});

test('application status, known errors and dynamic reasons translate without changing raw values', () => {
  setLocale('zh');
  assert.equal(getLocale(), 'zh');
  assert.equal(uiMessage('not_run'), '未执行');
  assert.equal(errorText('Repository already imported'), '仓库已导入');
  assert.equal(
    uiMessage('Last run failed. Review before choosing to continue.'),
    '上次运行失败。继续前请先审查。',
  );
  assert.equal(
    uiMessage('Dependency My English 任务 has a newer or incomplete execution.'),
    '依赖 My English 任务 有更新或未完成的执行。',
  );
  assert.equal(uiMessage('Step 4 vs 2'), '步数 4 与 2');
  assert.equal(uiMessage('raw $LOG 中文\ncommand --flag'), 'raw $LOG 中文\ncommand --flag');
  assert.equal(errorText('custom diagnostic --flag'), '请求失败: custom diagnostic --flag');
  setLocale('en');
  assert.equal(uiMessage('failed'), 'failed');
});

test('UI prose is catalogued; remaining literal JSX is limited to technical notation and examples', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const ts = await import('typescript');
  const root = new URL('../apps/web/src/', import.meta.url);
  const allowed = new Set([
    'px',
    'Ctrl / ⌘ K',
    'Ctrl / ⌘ Shift N',
    'Esc',
    'OpenAI Codex',
    'Claude Code',
    '⌘ K',
    'CPU',
    'RAM',
    'GB',
    'CPU ·',
    'MiB RAM ·',
    's',
    'KiB/s',
    'GiB',
    '· GPU',
    'PID',
    '· CPU',
    '· RSS',
    'W',
    '0–100%',
    'English',
    '中文',
  ]);
  const violations: string[] = [];
  for (const file of (await readdir(root)).filter((file) => file.endsWith('.tsx'))) {
    const source = ts.createSourceFile(
      file,
      await readFile(new URL(file, root), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: import('typescript').Node) => {
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (/[a-zA-Z\u4e00-\u9fff]/.test(text) && !allowed.has(text))
          violations.push(`${file}: ${text}`);
      }
      if (
        ts.isJsxAttribute(node) &&
        ['title', 'label', 'aria-label'].includes(node.name.getText(source)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text !== 'Language / 语言'
      )
        violations.push(`${file}: ${node.getText(source)}`);
      if (
        ts.isJsxAttribute(node) &&
        ['value', 'defaultValue', 'key', 'className', 'id', 'name', 'type'].includes(
          node.name.getText(source),
        )
      ) {
        const check = (child: import('typescript').Node) => {
          if (
            ts.isCallExpression(child) &&
            ['tr', 't', 'uiMessage'].includes(child.expression.getText(source))
          )
            violations.push(`${file}: translated machine attribute ${node.name.getText(source)}`);
          ts.forEachChild(child, check);
        };
        ts.forEachChild(node, check);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});

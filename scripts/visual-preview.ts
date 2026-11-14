import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { VisualReview } from '../examples/visual-review/VisualReview.tsx';
const result = await build({
  configFile: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    lib: {
      entry: resolve('examples/visual-review/browser.tsx'),
      formats: ['iife'],
      name: 'WorkspaceReview',
    },
  },
});
const outputs = Array.isArray(result) ? result : [result];
const chunk = outputs
  .flatMap((out) => ('output' in out ? out.output : []))
  .find((item) => item.type === 'chunk' && item.isEntry);
if (!chunk || chunk.type !== 'chunk') throw new Error('Missing preview entry');
const css = await readFile('apps/web/src/styles.css', 'utf8');
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Agent Workspace · Visual review</title><style>' +
  css +
  '\nbody{height:auto;min-height:100vh;overflow:auto}.preview-shell{max-width:1100px;margin:auto;padding:clamp(12px,4vw,48px)}.preview-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 22px}.preview-header h1{margin-top:5px}.preview-label{font-size:12px;color:#e6c893}.preview-history{margin-top:20px;padding:20px}.preview-group{margin-bottom:20px;font-size:22px}</style></head><body><div id="root">' +
  renderToString(createElement(VisualReview)) +
  '</div><script>' +
  chunk.code.replace(/<\/script/gi, '<\\/script') +
  '</script></body></html>';
await mkdir('dist', { recursive: true });
await writeFile('dist/visual-review.html', html);

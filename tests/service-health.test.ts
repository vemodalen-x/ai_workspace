import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

test('health probe verifies the actual page, JavaScript, auth and snapshot without leaking tokens', async () => {
  const commit = 'a'.repeat(40);
  let failure = '';
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.end('<div id="root"></div><script src="/assets/app.js"></script>');
    } else if (req.url === '/assets/app.js') {
      res.setHeader('Content-Type', failure === 'asset' ? 'text/html' : 'text/javascript');
      res.end('export {};');
    } else if (req.url === '/api/bootstrap') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: 'private-test-token', buildCommit: commit }));
    } else if (req.url === '/api/snapshot') {
      assert.equal(req.headers.authorization, 'Bearer private-test-token');
      res.statusCode = failure === 'api' ? 503 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ projects: [], nodes: failure === 'database' ? [] : [{}] }));
    } else if (req.url === '/api/monitor/overview' && failure !== 'monitor-missing') {
      assert.equal(req.headers.authorization, 'Bearer private-test-token');
      res.end(
        JSON.stringify(
          failure === 'monitor-body'
            ? {}
            : {
                sessions: [],
                sources: [],
                scannedAt: new Date().toISOString(),
              },
        ),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const cases = [
      { condition: '' },
      { condition: 'asset', error: /JavaScript unavailable/ },
      { condition: 'api', error: /Snapshot HTTP 503/ },
      { condition: 'database', error: /Invalid workspace snapshot/ },
      { condition: 'monitor-missing' },
      { condition: '', expected: commit },
      { condition: '', expected: 'b'.repeat(40), error: /does not match the expected commit/ },
      { condition: 'monitor-missing', expected: commit, error: /Monitor HTTP 404/ },
      { condition: 'monitor-body', expected: commit, error: /Invalid Workspace Monitor overview/ },
    ];
    for (const { condition, expected, error } of cases) {
      failure = condition;
      const args = [resolve('scripts/service-health.mjs')];
      if (expected) args.push('--expect-commit', expected);
      const child: ChildProcess = spawn(process.execPath, args, {
        env: { ...process.env, API_PORT: String(address.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
      const result: unknown[] = await once(child, 'exit');
      assert.equal(result[0], error ? 1 : 0, output);
      assert.ok(!output.includes('private-test-token'));
      assert.match(output, error ?? (expected ? /passed Monitor acceptance/ : /healthy/));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../apps/server/src/app.ts';
import { fixture, key, settle } from './helpers.ts';
import { redact } from '../packages/agent-adapters/process.ts';

test('HTTP auth, Host/Origin protections, validation, cursor replay', async () => {
  const { svc, project } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false, token: 'test-api-secret' });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (await app.inject({ url: '/api/snapshot', headers: { host: 'localhost' } })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/api/bootstrap', headers: { host: 'evil.example' } })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/bootstrap',
          headers: { host: 'localhost', origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal((await app.inject({ url: '/api/snapshot', headers })).statusCode, 200);
    const invalid = await app.inject({
      url: `/api/projects/${project.id}/tasks`,
      method: 'POST',
      headers,
      payload: { title: '' },
    });
    assert.equal(invalid.statusCode, 400);
    const created = await app.inject({
      url: `/api/projects/${project.id}/tasks`,
      method: 'POST',
      headers,
      payload: { title: 'From API' },
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();
    const requestKey = key();
    const request = {
      url: `/api/tasks/${task.id}/runs`,
      method: 'POST' as const,
      headers,
      payload: { requestKey },
    };
    const r = (await app.inject(request)).json();
    assert.equal((await app.inject(request)).json().id, r.id);
    await settle(svc, [r.id]);
    const first = (await app.inject({ url: '/api/events?after=0&limit=2', headers })).json();
    assert.equal(first.length, 2);
    const rest = (await app.inject({ url: `/api/events?after=${first[1].seq}`, headers })).json();
    assert.ok(rest.every((e: { seq: number }) => e.seq > first[1].seq));
    assert.equal((await app.inject({ url: '/api/events?after=-1', headers })).statusCode, 400);
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('WebSocket reconnect replays events after cursor without missing persisted state', async () => {
  const { svc } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  try {
    const a = svc.emit({ type: 'Log', data: { text: 'before-connect' } })!;
    const received = await new Promise<{ seq: number }[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/events/ws?after=${a.seq}`, [
        'workspace',
        `auth.${token}`,
      ]);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WS timeout'));
      }, 3000);
      ws.on('open', () => svc.emit({ type: 'Log', data: { text: 'after-connect' } }));
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        clearTimeout(timer);
        ws.close();
        resolve([value]);
      });
    });
    assert.equal(received[0].seq, a.seq + 1);
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('sensitive environment values and common bearer tokens are redacted', () => {
  process.env.TEST_API_KEY = 'secret-value-12345';
  const result = redact({ text: 'secret-value-12345 Bearer abc.def.ghi sk-abcdefghijklmnopqrst' });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal(JSON.stringify(result).includes('abc.def'), false);
  delete process.env.TEST_API_KEY;
});

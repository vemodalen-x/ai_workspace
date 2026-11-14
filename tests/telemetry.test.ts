import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Store } from '../packages/orchestration/store.ts';
import { TelemetryStore } from '../packages/resource-manager/telemetry-store.ts';
import { NodeMonitor } from '../packages/resource-manager/node-monitor.ts';
import { parseGpus, parseGpuProcesses } from '../packages/resource-manager/nvidia.ts';
import { reserve } from '../packages/resource-manager/index.ts';
import { metricsSchema, telemetryFresh } from '../packages/shared/telemetry.ts';
import { allocationSchema, type Metrics } from '../packages/shared/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { jsonProcess } from '../packages/agent-adapters/process.ts';
import { fixture, key, settle } from './helpers.ts';
const sample = (at = Date.now()): Metrics => ({
  at: new Date(at).toISOString(),
  cpuPercent: 12,
  cores: 8,
  ramTotalMb: 32000,
  ramUsedMb: 4000,
  ramFreeMb: 28000,
  disk: null,
  network: null,
  processes: [],
  gpus: parseGpus(
    '0, GPU-aaaa, RTX A6000, 20, 1000, 48000, 65, 120.5, 300\n1, GPU-bbbb, RTX A6000, N/A, N/A, 48000, N/A, N/A, 300',
  ),
});

test('multi-GPU CSV keeps UUID identity and N/A fields without discarding the device', () => {
  const m = metricsSchema.parse(sample());
  assert.equal(m.gpus?.length, 2);
  assert.equal(m.gpus?.[0].powerW, 120.5);
  assert.equal(m.gpus?.[1].utilization, null);
  assert.equal(m.gpus?.[1].usedMb, null);
  assert.equal(parseGpus('garbage').length, 0);
  assert.equal(
    parseGpus('0, GPU-aaaa, "GPU, special", 0, 0, 1024, 42, 10, 20')[0].name,
    'GPU, special',
  );
  assert.deepEqual(parseGpuProcesses('GPU-aaaa, 123, 500\nGPU-bbbb, 456, [N/A]\ninvalid, N/A, 0'), [
    { gpuId: 'GPU-aaaa', pid: 123, usedMb: 500 },
    { gpuId: 'GPU-bbbb', pid: 456, usedMb: null },
  ]);
  assert.throws(() => metricsSchema.parse({ ...m, cpuPercent: NaN }));
});

test('UUID/index aliases share reservations; stale, unknown memory and pressure fail closed', () => {
  const store = new Store(':memory:');
  const n = {
    id: 'n',
    name: 'test',
    kind: 'local' as const,
    status: 'online' as const,
    cpu: 8,
    ramMb: 32000,
  };
  const m = sample();
  const a = allocationSchema.parse({ gpu: '0', vramMb: 30000 });
  try {
    store.tx(() => reserve(store, 'one', n, a, m));
    assert.equal(store.get('reservations', 'one').gpu, 'GPU-aaaa');
    assert.throws(
      () => store.tx(() => reserve(store, 'two', n, { ...a, gpu: 'GPU-aaaa', vramMb: 18000 }, m)),
      /Insufficient/,
    );
    assert.throws(
      () => store.tx(() => reserve(store, 'three', n, { ...a, gpu: '1' }, m)),
      /memory telemetry unavailable/,
    );
    assert.throws(
      () => store.tx(() => reserve(store, 'four', n, a, sample(Date.now() - 60000))),
      /stale/,
    );
    assert.throws(
      () =>
        store.tx(() =>
          reserve(
            store,
            'five',
            { ...n, kind: 'ssh' },
            allocationSchema.parse({}),
            sample(Date.now() - 60000),
          ),
        ),
      /stale/,
    );
    assert.equal(store.all('reservations').length, 1);
  } finally {
    store.close();
  }
});

test('receipt freshness ignores worker clock skew; history survives restart and is bounded', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'telemetry-')), 'test.db');
  let store = new Store(path);
  let telemetry = new TelemetryStore(store.db);
  const start = Date.now();
  const value = sample(start + 86400000);
  const accepted = telemetry.record('n', value, start);
  assert.equal(telemetryFresh(accepted, start), true);
  assert.equal(telemetryFresh(accepted, start + 45001), false);
  assert.equal(telemetryFresh(value, start), false);
  telemetry.record('n', value, start + 3000);
  assert.equal(telemetry.history('n').length, 1);
  for (let i = 1; i < 2165; i++) telemetry.record('n', value, start + i * 10000);
  telemetry.record('other', value, start);
  assert.equal(telemetry.history('n', 2160).length, 2160);
  store.close();
  store = new Store(path);
  telemetry = new TelemetryStore(store.db);
  try {
    assert.equal(telemetry.history('n', 2).length, 2);
    assert.equal(telemetry.history('other').length, 1);
    assert.throws(() => telemetry.history('n', 2161), /Invalid/);
    assert.equal(telemetry.history('missing').length, 0);
  } finally {
    store.close();
  }
});

test('node polling isolates failure, uses backoff, single-flight, concurrency two and abortable shutdown', async () => {
  let clock = 0;
  const calls: string[] = [];
  const releases = new Map<string, () => void>();
  const monitor = new NodeMonitor(
    async (id, signal) => {
      calls.push(id);
      if (id === 'bad') throw new Error('offline');
      await new Promise<void>((resolve) => {
        releases.set(id, resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    () => clock,
  );
  const a = monitor.refresh('a');
  assert.equal(monitor.refresh('a'), a);
  const b = monitor.refresh('bad');
  await assert.rejects(monitor.refresh('over'), /Two node/);
  await assert.rejects(b, /offline/);
  releases.get('a')!();
  await a;
  await monitor.poll(['bad', 'a']);
  assert.deepEqual(calls, ['a', 'bad']);
  clock = 30001;
  const polling = monitor.poll(['bad', 'a']);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.filter((x) => x === 'bad').length, 2);
  assert.equal(calls.includes('third'), false);
  await monitor.stop();
  await polling;
  await assert.rejects(monitor.refresh('a'), /stopped/);
});

test('telemetry API is authenticated, bounded, node scoped, and does not fill lifecycle events', async () => {
  const { svc } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    const before = svc.store.events().length;
    svc.acceptMetrics('local', sample());
    assert.equal(svc.store.events().length, before);
    assert.equal(
      (await app.inject({ url: '/api/nodes/local/telemetry', headers: { host: 'localhost' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/api/nodes/local/telemetry?limit=2161', headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: '/api/nodes/missing/telemetry', headers })).statusCode,
      404,
    );
    const reply = await app.inject({ url: '/api/nodes/local/telemetry', headers });
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.json().length, 1);
    assert.throws(() => svc.acceptMetrics('local', { cpuPercent: 'broken' }));
    assert.equal(svc.metrics.local.cpuPercent, 12);
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('experiment context is frozen in a run, reaches the adapter brief, and changes stale old evidence', async () => {
  const { svc, project } = await fixture();
  try {
    const experiment = {
      group: 'segmentation',
      dataset: 'v1',
      datasetVersion: 'sha256:test-fixture',
      seed: 42,
      parameters: { lr: 0.001, fp16: true },
    };
    const task = svc.saveTask(project.id, { title: 'Experiment fixture', experiment });
    const run = svc.enqueue(task.id, { requestKey: key() });
    await settle(svc, [run.id]);
    const done = svc.store.get('runs', run.id);
    assert.deepEqual(done.manifest?.taskSpec.experiment, experiment);
    const brief = svc.store
      .all('artifacts')
      .find((a) => a.runId === run.id && a.kind === 'context');
    assert.match(brief!.content, /segmentation/);
    svc.saveTask(project.id, { ...task, experiment: { ...experiment, seed: 43 } }, task.id);
    assert.throws(() => svc.assertCurrentResult(run.sessionId), /inputs changed/);
    assert.equal(svc.store.get('runs', run.id).manifest?.taskSpec.experiment?.seed, 42);
  } finally {
    await svc.shutdown();
  }
});

test('standalone worker metrics operation returns real telemetry without agent authentication', async () => {
  const lines: Record<string, unknown>[] = [];
  await jsonProcess({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('apps/worker/src/index.ts')],
    input: '{"op":"metrics"}\n',
    keepStdinOpen: true,
    signal: AbortSignal.timeout(15000),
    onLine: (line) => lines.push(line as Record<string, unknown>),
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'metrics');
  const m = metricsSchema.parse(lines[0].metrics);
  assert.ok(m.cores > 0);
  assert.ok(m.ramTotalMb > 0);
  assert.equal('providers' in lines[0], false);
});

test('run-window summary excludes other hosts, GPUs and times and counts missing readings honestly', () => {
  const store = new Store(':memory:');
  try {
    const db = new TelemetryStore(store.db),
      t = Date.now();
    const first = sample(t),
      second = sample(t);
    second.gpus![0] = { ...second.gpus![0], usedMb: 2000, utilization: null };
    second.gpus![1] = { ...second.gpus![1], usedMb: 46000, utilization: 100 };
    db.record('host-a', first, t);
    db.record('host-a', second, t + 11000);
    db.record('host-b', second, t + 11000);
    db.record('host-a', second, t + 25000);
    const from = new Date(t).toISOString(),
      until = new Date(t + 12000).toISOString();
    const w = db.runWindow('host-a', 'GPU-aaaa', from, until);
    assert.equal(w.sampleCount, 2);
    assert.equal(w.gpuUtilSamples, 1);
    assert.equal(w.meanGpuUtil, 20);
    assert.equal(w.maxGpuMemoryMiB, 2000);
    assert.equal(db.runWindow('host-a', null, from, until).maxGpuMemoryMiB, null);
    assert.equal(db.runWindow('missing', 'GPU-aaaa', from, until).sampleCount, 0);
  } finally {
    store.close();
  }
});

test('selected GPU UUID reaches the actual validation child and frozen manifest', async () => {
  const { svc, project } = await fixture();
  try {
    svc.acceptMetrics('local', sample());
    const task = svc.saveTask(project.id, {
      title: 'CUDA visibility assertion',
      allocation: { gpu: '0', vramMb: 512 },
      validationCommand: [
        process.execPath,
        '-e',
        "if (process.env.CUDA_VISIBLE_DEVICES !== 'GPU-aaaa') process.exit(2)",
      ],
    });
    const run = svc.enqueue(task.id, { requestKey: key(), allowValidation: true });
    const [done] = await settle(svc, [run.id]);
    assert.equal(done.state, 'completed');
    assert.equal(done.manifest?.environment.gpuId, 'GPU-aaaa');
  } finally {
    await svc.shutdown();
  }
});

test('fleet presentation distinguishes a live two-card server from an offline server with retained measurements', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Compute } = await import('../apps/web/src/Compute.tsx');
  const { svc } = await fixture();
  try {
    svc.acceptMetrics('local', sample());
    const node = await svc.addNode({
      name: 'GPU lab host',
      sshAlias: 'example-lab',
      workerPath: '/srv/worker.js',
      cpu: 4,
      ramMb: 4000,
    });
    await assert.rejects(
      svc.addNode({ ...node, sshAlias: node.sshAlias!.toUpperCase() }),
      /already registered/,
    );
    svc.acceptMetrics(node.id, sample());
    svc.store.put('nodes', { ...node, status: 'offline' });
    const rendered = renderToStaticMarkup(
      createElement(Compute, {
        data: svc.snapshot(),
        onAdd: () => {},
        onRefresh: () => {},
        onTask: () => {},
      }),
    );
    assert.match(rendered, /1 \/ 2 nodes with fresh telemetry/);
    assert.match(rendered, /2 observed GPUs on fresh nodes/);
    assert.match(rendered, /Last observed values below; not live capacity/);
    assert.match(rendered, /GPU-bbbb/);
    assert.match(rendered, /GPU lab host/);
  } finally {
    await svc.shutdown();
  }
});

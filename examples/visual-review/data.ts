// Fixed synthetic fixtures used only by the standalone design review and its tests.
import {
  taskInput,
  type Artifact,
  type Run,
  type Snapshot,
  type Metrics,
} from '../../packages/shared/index.ts';
import type { GpuMetrics, TelemetrySample } from '../../packages/shared/telemetry.ts';
export const exampleTime = Date.UTC(2026, 10, 7, 8);
const iso = (t: number) => new Date(t).toISOString();
function metrics(gpus: GpuMetrics[], age: number): Metrics {
  return {
    at: iso(exampleTime - age),
    receivedAt: iso(exampleTime - age),
    cpuPercent: 24,
    cores: 16,
    ramFreeMb: 32000,
    ramUsedMb: 32000,
    ramTotalMb: 64000,
    disk: null,
    network: null,
    processes: [],
    gpus,
  };
}
export const fleet: Pick<Snapshot, 'nodes' | 'metrics' | 'reservations'> = {
  nodes: [
    { id: 'train', name: 'Training server', kind: 'ssh', status: 'online', cpu: 16, ramMb: 64000 },
    { id: 'eval', name: 'Evaluation server', kind: 'ssh', status: 'offline', cpu: 8, ramMb: 32000 },
  ],
  metrics: {
    train: metrics(
      [
        {
          id: 'GPU-sample-a',
          index: '0',
          name: 'RTX A6000',
          totalMb: 49152,
          usedMb: 16384,
          utilization: 73,
          temperatureC: 67,
          powerW: 212,
          powerLimitW: 300,
        },
        {
          id: 'GPU-sample-b',
          index: '1',
          name: 'RTX A6000',
          totalMb: 49152,
          usedMb: 4096,
          utilization: 12,
          temperatureC: 43,
          powerW: 72,
          powerLimitW: 300,
        },
      ],
      0,
    ),
    eval: metrics(
      [
        {
          id: 'GPU-sample-c',
          index: '0',
          name: 'RTX 4090',
          totalMb: 24576,
          usedMb: 8192,
          utilization: null,
          temperatureC: null,
          powerW: null,
          powerLimitW: null,
        },
      ],
      120000,
    ),
  },
  reservations: [
    {
      id: 'allocation',
      runId: 'sample',
      nodeId: 'train',
      cpu: 2,
      ramMb: 1024,
      gpu: 'GPU-sample-a',
      vramMb: 8192,
      quarantined: false,
    },
  ],
};
export function history(nodeId: string): TelemetrySample[] {
  const source = fleet.metrics[nodeId];
  const end = Date.parse(source.receivedAt!);
  return [0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19].map((i) => {
    const receivedAt = iso(end - (19 - i) * 10000);
    return {
      nodeId,
      receivedAt,
      metrics: {
        ...source,
        at: receivedAt,
        receivedAt,
        gpus: source.gpus!.map((g, j) => ({
          ...g,
          utilization:
            g.utilization === null || i === 3
              ? null
              : Math.min(100, Math.max(0, g.utilization + Math.round(Math.sin(i + j) * 12))),
        })),
      },
    };
  });
}
const cases = [
  {
    id: 'int8-cal',
    title: 'INT8 calibrated',
    precision: 'INT8',
    data: 'v3',
    step: 20,
    score: 0.746,
    speed: 161,
  },
  {
    id: 'fp16-big',
    title: 'FP16 · larger batch',
    precision: 'FP16',
    data: 'v4',
    step: 20,
    score: 0.762,
    speed: 129,
  },
  {
    id: 'fp16-ref',
    title: 'FP16 baseline',
    precision: 'FP16',
    data: 'v3',
    step: 20,
    score: 0.752,
    speed: 108,
  },
];
export const runs: Run[] = cases.map((c) => {
  const taskSpec = taskInput.parse({
    title: c.title,
    experiment: {
      group: 'Quantization ablation',
      dataset: 'Validation split',
      datasetVersion: c.data,
      seed: 42,
      parameters: { precision: c.precision, batch_size: c.id === 'fp16-big' ? 16 : 8 },
    },
  });
  return {
    id: c.id,
    sessionId: c.id,
    taskId: c.id,
    projectId: 'sample-project',
    nodeId: 'train',
    state: 'completed',
    prompt: '',
    requestKey: c.id,
    resultCommit: c.id,
    allocation: taskSpec.allocation,
    createdAt: iso(exampleTime),
    manifest: {
      version: 1,
      taskRevision: 1,
      contextRevision: 1,
      taskSpec,
      projectContext: '',
      dependencies: [],
      providerVersion: null,
      environment: { nodeId: 'train', platform: null, runtime: null },
    },
  };
});
export const artifacts: Artifact[] = cases.map((c) => ({
  id: c.id,
  runId: c.id,
  kind: 'validation',
  name: 'command-validation.json',
  createdAt: iso(exampleTime),
  content: JSON.stringify({
    passed: true,
    exitCode: 0,
    commit: c.id,
    metrics: [
      { name: 'val_mIoU', value: c.score, unit: 'ratio', step: c.step },
      { name: 'throughput', value: c.speed, unit: 'images/s', step: c.step },
    ],
  }),
}));

import { gpuCapacity } from '../shared/gpu-capacity.ts';
import os from 'node:os';
import si from 'systeminformation';
import { collectNvidia } from './nvidia.ts';
import { telemetryFresh } from '../shared/telemetry.ts';
import type { Metrics, Allocation, ComputeNode } from '../shared/index.ts';
import { now } from '../shared/index.ts';
import type { Store } from '../orchestration/store.ts';
export async function collectMetrics(pids: number[] = []): Promise<Metrics> {
  const [cpu, mem, disk, net, proc, gpu] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    pids.length ? si.processes() : Promise.resolve(null),
    collectNvidia(),
  ]);
  const m = mem.status === 'fulfilled' ? mem.value : null;
  return {
    at: now(),
    cpuPercent: cpu.status === 'fulfilled' ? cpu.value.currentLoad : null,
    cores: os.cpus().length,
    ramTotalMb: (m?.total ?? os.totalmem()) / 1048576,
    ramUsedMb: (m?.active ?? os.totalmem() - os.freemem()) / 1048576,
    ramFreeMb: (m?.available ?? os.freemem()) / 1048576,
    disk:
      disk.status === 'fulfilled' && disk.value[0]
        ? { usedGb: disk.value[0].used / 1e9, freeGb: disk.value[0].available / 1e9 }
        : null,
    network:
      net.status === 'fulfilled' &&
      net.value[0] &&
      [net.value[0].rx_sec, net.value[0].tx_sec].every(
        (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
      )
        ? { rxBytesSec: net.value[0].rx_sec, txBytesSec: net.value[0].tx_sec }
        : null,
    ...(gpu.status === 'fulfilled' ? gpu.value : { gpus: null, gpuProcesses: null }),
    processes:
      proc.status === 'fulfilled' && proc.value
        ? proc.value.list
            .filter((p) => pids.includes(p.pid))
            .map((p) => ({ pid: p.pid, cpu: p.cpu, ramMb: p.memRss / 1024 }))
        : [],
  };
}
/** Must be called in the caller's BEGIN IMMEDIATE transaction. */
export function reserve(
  store: Store,
  runId: string,
  node: ComputeNode,
  a: Allocation,
  metrics?: Metrics,
) {
  if (node.status !== 'online') throw new Error('Execution node offline or not checked');
  if (node.kind === 'ssh' && !telemetryFresh(metrics))
    throw new Error('Remote telemetry stale or unavailable; refresh the node');
  const used = store.all('reservations').filter((r) => r.nodeId === node.id);
  const cpu = used.reduce((s, r) => s + r.cpu, 0),
    ram = used.reduce((s, r) => s + r.ramMb, 0);
  if (cpu + a.cpu > node.cpu || ram + a.ramMb > node.ramMb)
    throw new Error('Insufficient schedulable CPU/RAM');
  if (metrics && a.ramMb > metrics.ramFreeMb)
    throw new Error('Insufficient currently available RAM');
  if (a.gpu !== null) {
    if (!metrics) throw new Error('Requested GPU unavailable');
    if (!telemetryFresh(metrics))
      throw new Error('GPU telemetry stale or unavailable; refresh the node');
    const gpu = metrics?.gpus?.find((g) => g.id === a.gpu || g.index === a.gpu);
    if (!gpu) throw new Error('Requested GPU unavailable');
    const { remainingMiB } = gpuCapacity(gpu, used, node.id);
    if (remainingMiB === null) throw new Error('GPU memory telemetry unavailable');
    if (a.vramMb > remainingMiB) throw new Error('Insufficient GPU VRAM soft budget');
  } else if (a.vramMb > 0) throw new Error('Select a GPU for VRAM allocation');
  store.put('reservations', {
    id: runId,
    runId,
    nodeId: node.id,
    cpu: a.cpu,
    ramMb: a.ramMb,
    gpu: metrics?.gpus?.find((g) => g.id === a.gpu || g.index === a.gpu)?.id ?? a.gpu,
    vramMb: a.vramMb,
    quarantined: false,
  });
}

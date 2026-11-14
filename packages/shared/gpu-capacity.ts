import type { Reservation } from './index.ts';
import type { GpuMetrics } from './telemetry.ts';

/** Match the admission rule, including legacy index-based and quarantined reservations. */
export function gpuCapacity(gpu: GpuMetrics, reservations: Reservation[], nodeId: string) {
  const reservedMiB = reservations.reduce((sum, r) => {
    const sameDevice = r.gpu === gpu.id || (gpu.index !== undefined && r.gpu === gpu.index);
    return r.nodeId === nodeId && sameDevice ? sum + r.vramMb : sum;
  }, 0);
  const remainingMiB =
    gpu.usedMb === null || gpu.totalMb === null ? null : gpu.totalMb - gpu.usedMb - reservedMiB;
  return { reservedMiB, remainingMiB };
}

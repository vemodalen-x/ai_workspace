import { z } from 'zod';
const measure = z.number().finite().nonnegative().nullable();
export const gpuSchema = z.object({
  id: z.string().min(1).max(100), // UUID when available; index only for legacy workers
  index: z.string().max(10).optional(),
  name: z.string().max(200),
  utilization: measure.refine((v) => v === null || v <= 100),
  usedMb: measure,
  totalMb: measure,
  temperatureC: measure.optional(),
  powerW: measure.optional(),
  powerLimitW: measure.optional(),
});
export const metricsSchema = z.object({
  at: z.iso.datetime(),
  receivedAt: z.iso.datetime().optional(),
  cpuPercent: measure.refine((v) => v === null || v <= 100),
  cores: z.number().int().nonnegative(),
  ramTotalMb: z.number().finite().nonnegative(),
  ramUsedMb: z.number().finite().nonnegative(),
  ramFreeMb: z.number().finite().nonnegative(),
  disk: z
    .object({
      usedGb: z.number().finite().nonnegative(),
      freeGb: z.number().finite().nonnegative(),
    })
    .nullable(),
  network: z
    .object({
      rxBytesSec: z.number().finite().nonnegative(),
      txBytesSec: z.number().finite().nonnegative(),
    })
    .nullable(),
  gpus: z
    .array(gpuSchema)
    .max(256)
    .refine((gpus) => new Set(gpus.map((g) => g.id)).size === gpus.length, 'Duplicate GPU identity')
    .nullable(),
  gpuProcesses: z
    .array(
      z.object({ gpuId: z.string().max(100), pid: z.number().int().positive(), usedMb: measure }),
    )
    .max(4096)
    .nullable()
    .optional(),
  processes: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        cpu: z.number().finite(),
        ramMb: z.number().finite().nonnegative(),
      }),
    )
    .max(4096),
});
export type GpuMetrics = z.infer<typeof gpuSchema>;
export type TelemetrySample = {
  nodeId: string;
  receivedAt: string;
  metrics: z.infer<typeof metricsSchema>;
};
export { telemetryFresh } from './sample-time.ts';

/** These are observations of a shared host/device during a Run, never per-process accounting. */
export interface RunTelemetry {
  nodeId: string;
  gpuId: string | null;
  sampleCount: number;
  firstSample: string | null;
  lastSample: string | null;
  gpuUtilSamples: number;
  meanGpuUtil: number | null;
  maxGpuMemoryMiB: number | null;
  maxGpuTemperatureC: number | null;
}

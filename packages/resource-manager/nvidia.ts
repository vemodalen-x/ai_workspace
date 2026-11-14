import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuMetrics } from '../shared/telemetry.ts';
import type { Metrics } from '../shared/index.ts';
// nvidia-smi is an optional collector. N/A is never converted to zero.
function number(value?: string) {
  if (!value || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function csv(line: string): string[] {
  const fields: string[] = [];
  let quoted = false,
    field = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else field += char;
  }
  if (quoted) return [];
  fields.push(field.trim());
  return fields;
}
export function parseGpus(output: string): GpuMetrics[] {
  const result: GpuMetrics[] = [];
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [index, uuid, name, util, used, total, temp, power, limit] = csv(line);
    if (!/^\d+$/.test(index ?? '') || !/^GPU-[a-zA-Z0-9-]+$/.test(uuid ?? '') || !name) continue;
    const utilization = number(util);
    result.push({
      id: uuid,
      index,
      name,
      utilization: utilization !== null && utilization <= 100 ? utilization : null,
      usedMb: number(used),
      totalMb: number(total),
      temperatureC: number(temp),
      powerW: number(power),
      powerLimitW: number(limit),
    });
  }
  return result;
}
export function parseGpuProcesses(output: string): NonNullable<Metrics['gpuProcesses']> {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [gpuId, pidText, memory] = csv(line);
      const pid = number(pidText);
      return /^GPU-[a-zA-Z0-9-]+$/.test(gpuId ?? '') &&
        pid !== null &&
        Number.isInteger(pid) &&
        pid > 0
        ? [{ gpuId, pid, usedMb: number(memory) }]
        : [];
    });
}
export async function collectNvidia() {
  const query = (args: string) =>
    promisify(execFile)('nvidia-smi', [args, '--format=csv,noheader,nounits'], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  const [gpu, processes] = await Promise.allSettled([
    query(
      '--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
    ),
    query('--query-compute-apps=gpu_uuid,pid,used_gpu_memory'),
  ]);
  const parsed = gpu.status === 'fulfilled' ? parseGpus(gpu.value.stdout) : null;
  return {
    gpus: parsed?.length ? parsed : null,
    gpuProcesses:
      processes.status === 'fulfilled' ? parseGpuProcesses(processes.value.stdout) : null,
  };
}

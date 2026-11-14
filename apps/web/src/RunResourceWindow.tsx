import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Run } from '../../../packages/shared/index.ts';
import type { RunTelemetry } from '../../../packages/shared/telemetry.ts';
import { api } from './api.ts';
export function RunResourceWindow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ['run-telemetry', run.id, run.endedAt ?? 'active'],
    enabled: open,
    queryFn: () => api<{ window: RunTelemetry | null }>(`/runs/${run.id}/telemetry`),
    refetchInterval: open && run.state === 'running' ? 15000 : false,
  });
  const w = result.data?.window;
  const ex = run.manifest?.taskSpec.experiment;
  const display = (v: number | null, unit: string) =>
    v === null ? 'Unavailable' : `${v.toFixed(1)} ${unit}`;
  return (
    <details className="execution-manifest" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Experiment & hardware observations</summary>
      {ex && (
        <p>
          {ex.group} · dataset {ex.dataset || 'unset'} @ {ex.datasetVersion || 'unset'} · seed{' '}
          {ex.seed ?? 'unset'}
          <br />
          <code>{JSON.stringify(ex.parameters)}</code>
        </p>
      )}
      {result.isError ? (
        <p role="alert">{result.error.message}</p>
      ) : result.isLoading ? (
        <p>Loading samples…</p>
      ) : !w?.sampleCount ? (
        <p>No retained samples in this Run’s known execution window.</p>
      ) : (
        <>
          <p>
            {run.telemetryAtFinish ? 'Saved at Run completion · ' : ''}
            {w.sampleCount} node samples · {w.firstSample} — {w.lastSample}
          </p>
          <p>Reserved device: {w.gpuId ?? 'No identified GPU'}</p>
          {w.gpuId && (
            <p>
              Mean utilization: {display(w.meanGpuUtil, '%')} ({w.gpuUtilSamples} readings) · Peak
              observed VRAM: {display(w.maxGpuMemoryMiB, 'MiB')} · Peak temperature:{' '}
              {display(w.maxGpuTemperatureC, '°C')}
            </p>
          )}
        </>
      )}
      <small>
        Shared-device readings within the Run time window. External jobs can contribute. Peaks
        between samples and expired history are not recoverable.
      </small>
    </details>
  );
}

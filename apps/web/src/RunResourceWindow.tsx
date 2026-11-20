import { t as tr, errorText } from './i18n.ts';
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
    v === null ? tr('Unavailable') : `${v.toFixed(1)} ${unit}`;
  return (
    <details className="execution-manifest" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary> {tr('Experiment & hardware observations')} </summary>
      {ex && (
        <p>
          {ex.group} {tr('· dataset')} {ex.dataset || tr('unset')} @{' '}
          {ex.datasetVersion || tr('unset')} {tr('· seed')} {ex.seed ?? tr('unset')}
          <br />
          <code>{JSON.stringify(ex.parameters)}</code>
        </p>
      )}
      {result.isError ? (
        <p role="alert">{errorText(result.error.message ?? '')}</p>
      ) : result.isLoading ? (
        <p> {tr('Loading samples…')} </p>
      ) : !w?.sampleCount ? (
        <p> {tr('No retained samples in this Run’s known execution window.')} </p>
      ) : (
        <>
          <p>
            {run.telemetryAtFinish ? tr('Saved at Run completion · ') : ''}
            {w.sampleCount} {tr('node samples ·')} {w.firstSample} — {w.lastSample}
          </p>
          <p>
            {' '}
            {tr('Reserved device:')} {w.gpuId ?? tr('No identified GPU')}
          </p>
          {w.gpuId && (
            <p>
              {' '}
              {tr('Mean utilization:')} {display(w.meanGpuUtil, '%')} ({w.gpuUtilSamples}{' '}
              {tr('readings) · Peak observed VRAM:')} {display(w.maxGpuMemoryMiB, 'MiB')}{' '}
              {tr('· Peak temperature:')} {display(w.maxGpuTemperatureC, '°C')}
            </p>
          )}
        </>
      )}
      <small>
        {' '}
        {tr(
          'Shared-device readings within the Run time window. External jobs can contribute. Peaks between samples and expired history are not recoverable.',
        )}{' '}
      </small>
    </details>
  );
}

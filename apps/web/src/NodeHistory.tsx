import { t as tr, errorText } from './i18n.ts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { HistoryChart } from './HistoryChart.tsx';
import type { TelemetrySample } from '../../../packages/shared/telemetry.ts';
export function NodeHistory({ nodeId, initialGpu }: { nodeId: string; initialGpu?: string }) {
  const [gpuId, setGpuId] = useState(initialGpu ?? '');
  const query = useQuery({
    queryKey: ['telemetry', nodeId],
    queryFn: () => api<TelemetrySample[]>(`/nodes/${nodeId}/telemetry?limit=120`),
    refetchInterval: 15000,
  });
  const samples = query.data ?? [];
  const gpus = Array.from(
    new Map(samples.flatMap((s) => s.metrics.gpus ?? []).map((g) => [g.id, g])).values(),
  );
  const selected = gpuId || gpus[0]?.id;
  return (
    <section className="telemetry-history" aria-label={tr('Node telemetry history')}>
      <b> {tr('Last 120 retained samples')} </b>

      {query.isLoading && <p role="status"> {tr('Loading history…')} </p>}
      {query.isError && (
        <p role="alert">
          {' '}
          {tr('History unavailable:')} {errorText(query.error.message ?? '')}
        </p>
      )}
      <HistoryChart samples={samples} label={tr('CPU utilization')} value={(m) => m.cpuPercent} />
      {gpus.length > 0 && (
        <>
          <label>
            {' '}
            {tr('GPU history')}{' '}
            <select value={selected} onChange={(e) => setGpuId(e.target.value)}>
              {gpuId && !gpus.some((g) => g.id === gpuId) && (
                <option value={gpuId}>
                  {gpuId} {tr('· no retained readings')}{' '}
                </option>
              )}
              {gpus.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · {g.id}
                </option>
              ))}
            </select>
          </label>
          <HistoryChart
            samples={samples}
            label={tr('GPU utilization')}
            value={(m) => m.gpus?.find((g) => g.id === selected)?.utilization ?? null}
          />
          <HistoryChart
            samples={samples}
            label={tr('VRAM used')}
            value={(m) => {
              const g = m.gpus?.find((g) => g.id === selected);
              return g?.usedMb != null && g.totalMb ? (g.usedMb / g.totalMb) * 100 : null;
            }}
          />
        </>
      )}
      {samples.length > 0 && (
        <small>
          {new Date(samples[0].receivedAt).toLocaleString()} —{' '}
          {new Date(samples.at(-1)!.receivedAt).toLocaleString()}
        </small>
      )}
    </section>
  );
}

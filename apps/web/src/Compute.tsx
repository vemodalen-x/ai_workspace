import { usePreference } from './preferences.ts';
import { useEffect, useState } from 'react';
import { NodeHistory } from './NodeHistory.tsx';
import { GpuCapacity } from './GpuCapacity.tsx';
import { Plus, RefreshCw } from 'lucide-react';
import type { Snapshot, Task } from '../../../packages/shared/index.ts';
import { telemetryFresh } from '../../../packages/shared/sample-time.ts';
const number = (v: number | null | undefined, unit = '') =>
  v == null ? 'Unavailable' : `${v.toFixed(1)}${unit}`;
export function Compute({
  data,
  onAdd,
  onRefresh,
  onTask,
}: {
  data: Snapshot;
  onAdd: () => void;
  onRefresh: (id: string) => void;
  onTask: (task: Task) => void;
}) {
  const [filter, setFilter] = usePreference('aw.compute.filter', '');
  const [asOf, setAsOf] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setAsOf(Date.now()), 3000);
    return () => clearInterval(timer);
  }, []);
  const [history, setHistory] = useState<{ nodeId: string; gpuId?: string } | null>(null);
  const matches = data.nodes.filter((n) =>
    `${n.name} ${n.sshAlias ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
  );
  function inspect(nodeId: string, gpuId: string) {
    setHistory({ nodeId, gpuId });
    requestAnimationFrame(() => {
      const panel = document.getElementById('history-' + nodeId);
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }

  const fresh = data.nodes.filter(
    (n) => n.status === 'online' && telemetryFresh(data.metrics[n.id], asOf),
  );
  const gpuCount = fresh.reduce((sum, n) => sum + (data.metrics[n.id]?.gpus?.length ?? 0), 0);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Compute fleet</h1>
          <p>
            {fresh.length} / {data.nodes.length} nodes with fresh telemetry · {gpuCount} observed
            GPUs on fresh nodes
          </p>
        </div>
        <button className="primary" onClick={onAdd}>
          <Plus size={15} />
          Add SSH node
        </button>
      </div>
      <label className="fleet-filter">
        Find server
        <input
          placeholder="Name or SSH alias"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <GpuCapacity
        asOf={asOf}
        data={data}
        nodeIds={new Set(matches.map((n) => n.id))}
        inspect={inspect}
      />
      <h2 className="server-detail-heading">Server details</h2>
      <div className="fleet-list">
        {matches.map((n) => {
          const m = data.metrics[n.id];
          const status =
            n.status === 'offline'
              ? 'offline'
              : telemetryFresh(m, asOf) && n.status === 'online'
                ? 'live'
                : 'stale';
          const reservations = data.reservations.filter((r) => r.nodeId === n.id);
          return (
            <section key={n.id} className={`surface fleet-node fleet-${status}`}>
              <div className="section-heading">
                <div>
                  <h3>
                    {n.name}{' '}
                    <span className={`badge ${status === 'live' ? 'running' : 'blocked'}`}>
                      {status}
                    </span>
                  </h3>
                  <small>
                    {n.kind === 'local' ? 'Local host' : `SSH · ${n.sshAlias}`} ·{' '}
                    {m?.receivedAt
                      ? `Received ${new Date(m.receivedAt).toLocaleTimeString()}`
                      : 'No current sample'}
                  </small>
                </div>
                <button className="secondary small" onClick={() => onRefresh(n.id)}>
                  <RefreshCw size={13} />
                  Refresh
                </button>
              </div>
              {status !== 'live' && (
                <p role="status">
                  {m
                    ? 'Last observed values below; not live capacity.'
                    : 'No current telemetry. Historical samples may still be available.'}
                </p>
              )}
              {n.telemetryError && <p role="alert">{n.telemetryError}</p>}
              <div className="fleet-summary">
                <span>
                  CPU <b>{number(m?.cpuPercent, '%')}</b>
                </span>
                <span>
                  RAM <b>{number(m ? m.ramUsedMb / 1024 : null, ' GiB')}</b>
                </span>
                <span>
                  Disk free <b>{number(m?.disk?.freeGb, ' GB')}</b>
                </span>
                <span>
                  Network RX/TX{' '}
                  <b>
                    {number(m?.network ? m.network.rxBytesSec / 1024 : null)} /{' '}
                    {number(m?.network ? m.network.txBytesSec / 1024 : null)} KiB/s
                  </b>
                </span>
                <span>
                  Reserved{' '}
                  <b>
                    {reservations.reduce((s, r) => s + r.cpu, 0)} / {n.cpu} CPU ·{' '}
                    {number(reservations.reduce((s, r) => s + r.ramMb, 0) / 1024)} /{' '}
                    {number(n.ramMb / 1024)} GiB
                  </b>
                </span>
              </div>
              <div className="node-runs">
                {reservations.map((r) => {
                  const run = data.runs.find((x) => x.id === r.runId);
                  const task = data.tasks.find((t) => t.id === run?.taskId);
                  const attempt = data.attempts.find((a) => a.id === r.runId);
                  const trial = attempt && data.trials.find((t) => t.id === attempt.trialId);
                  const experiment = trial?.experiment ?? run?.manifest?.taskSpec.experiment;
                  return (
                    <div key={r.id}>
                      {trial && <b>{trial.title} · command trial</b>}
                      {task && (
                        <button className="secondary small" onClick={() => onTask(task)}>
                          {task.title}
                        </button>
                      )}
                      <small>
                        {experiment
                          ? `${experiment.group} · seed ${experiment.seed ?? 'unset'} · ${experiment.datasetVersion || 'unversioned data'}`
                          : 'No experiment specification'}{' '}
                        · {r.quarantined ? 'QUARANTINED reservation' : 'Reserved'} · GPU{' '}
                        {r.gpu ?? 'none'}
                      </small>
                    </div>
                  );
                })}
                {!reservations.length && <small>No workspace reservations</small>}
              </div>
              {Boolean(m?.processes.length) && (
                <details>
                  <summary>Tracked host processes ({m?.processes.length})</summary>
                  {m?.processes.map((p) => (
                    <div key={p.pid} className="gpu-process">
                      PID {p.pid} · CPU {number(p.cpu, '%')} · RSS {number(p.ramMb, ' MiB')}
                    </div>
                  ))}
                </details>
              )}
              <details>
                <summary>
                  GPU compute processes ({m?.gpuProcesses?.length ?? 'Unavailable'})
                </summary>
                <p>PID and GPU UUID only. This does not prove ownership by a workspace Run.</p>
                {m?.gpuProcesses?.slice(0, 100).map((p, i) => (
                  <div className="gpu-process" key={`${p.gpuId}-${p.pid}-${i}`}>
                    <code>{p.gpuId}</code> PID {p.pid} · {number(p.usedMb, ' MiB')}
                  </div>
                ))}
                {(m?.gpuProcesses?.length ?? 0) > 100 && <p>First 100 processes shown.</p>}
              </details>
              <button
                className="secondary small"
                aria-expanded={history?.nodeId === n.id}
                onClick={() => setHistory(history?.nodeId === n.id ? null : { nodeId: n.id })}
              >
                {history?.nodeId === n.id ? 'Hide history' : 'Show history'}
              </button>
              {history?.nodeId === n.id && (
                <div id={'history-' + n.id} tabIndex={-1}>
                  <NodeHistory
                    key={n.id + '/' + (history.gpuId ?? '')}
                    nodeId={n.id}
                    initialGpu={history.gpuId}
                  />
                </div>
              )}
            </section>
          );
        })}
      </div>
      {!matches.length && <p>No servers match this filter.</p>}
    </>
  );
}

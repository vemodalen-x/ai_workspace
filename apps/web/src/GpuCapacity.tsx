import { usePreference } from './preferences.ts';
import { ArrowDownWideNarrow, ChartNoAxesColumn, Cpu } from 'lucide-react';
import type { Snapshot } from '../../../packages/shared/index.ts';
import { gpuCapacity } from '../../../packages/shared/gpu-capacity.ts';
import { telemetryFresh } from '../../../packages/shared/sample-time.ts';

const gib = (n: number) => (n / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 });
function MemoryTrack({
  used,
  reserved,
  total,
}: {
  used: number | null;
  reserved: number;
  total: number | null;
}) {
  if (total === null || total <= 0 || used === null)
    return (
      <div className="memory-track missing-track" aria-label="Memory measurement unavailable" />
    );
  const usedPct = Math.min(100, (100 * used) / total);
  const reservedPct = Math.min(100 - usedPct, (100 * reserved) / total);
  return (
    <div className="memory-track" aria-hidden="true">
      <i className="memory-used" style={{ width: usedPct + '%' }} />
      <i className="memory-reserved" style={{ width: reservedPct + '%' }} />
    </div>
  );
}
export function GpuCapacity({
  data,
  nodeIds,
  inspect,
  asOf = Date.now(),
}: {
  data: Pick<Snapshot, 'nodes' | 'metrics' | 'reservations'>;
  asOf?: number;
  nodeIds: Set<string>;
  inspect: (nodeId: string, gpuId: string) => void;
}) {
  const [order, setOrder] = usePreference('aw.gpu.order', 'capacity');
  const rows = data.nodes
    .filter((n) => nodeIds.has(n.id))
    .flatMap((node) => {
      const m = data.metrics[node.id];
      const live = node.status === 'online' && telemetryFresh(m, asOf);
      return (m?.gpus ?? []).map((gpu) => {
        const { reservedMiB, remainingMiB } = gpuCapacity(gpu, data.reservations, node.id);
        return {
          node,
          gpu,
          live,
          reservedMiB,
          headroom: live && remainingMiB !== null ? Math.max(0, remainingMiB) : null,
        };
      });
    });
  rows.sort(
    (a, b) =>
      (order === 'capacity' ? (b.headroom ?? -1) - (a.headroom ?? -1) : 0) ||
      a.node.name.localeCompare(b.node.name) ||
      a.gpu.id.localeCompare(b.gpu.id),
  );
  return (
    <section className="surface capacity-board" aria-label="GPU capacity">
      <div className="visual-section-heading">
        <div>
          <h2>
            <Cpu size={17} /> GPU capacity
          </h2>
          <small>Headroom = total − observed use − soft reservations</small>
        </div>
        {rows.length > 1 && (
          <label className="sort-control">
            <ArrowDownWideNarrow size={15} />
            <select aria-label="GPU order" value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="capacity">Most headroom</option>
              <option value="server">Server name</option>
            </select>
          </label>
        )}
      </div>
      {rows.length ? (
        <>
          <div className="capacity-key">
            <span>
              <i className="memory-used" />
              Observed
            </span>
            <span>
              <i className="memory-reserved" />
              Reserved
            </span>
            <span>
              <i className="memory-free" />
              Headroom
            </span>
          </div>
          <div className="capacity-grid">
            {rows.map(({ node, gpu, live, reservedMiB, headroom }) => (
              <article
                key={node.id + '/' + gpu.id}
                className={'device-tile' + (live ? '' : ' inactive-device')}
              >
                <header>
                  <div>
                    <span className="device-host">
                      {node.name} · GPU {gpu.index ?? gpu.id}
                    </span>
                    <h3>{gpu.name}</h3>
                  </div>
                  <span className={'device-state ' + (live ? 'fresh' : 'old')}>
                    {live ? 'Live' : node.status === 'offline' ? 'Offline' : 'Stale'}
                  </span>
                </header>
                <div className="headroom-line">
                  <strong>{headroom === null ? 'Unavailable' : gib(headroom)}</strong>
                  {headroom !== null && <span>GiB</span>}
                  <small>VRAM headroom</small>
                </div>
                <MemoryTrack used={gpu.usedMb} reserved={reservedMiB} total={gpu.totalMb} />
                <div className="device-memory-label">
                  {gpu.usedMb === null ? '—' : gib(gpu.usedMb)} used · {gib(reservedMiB)} reserved ·{' '}
                  {gpu.totalMb === null ? '—' : gib(gpu.totalMb)} total GiB
                </div>
                <dl className="gpu-stats">
                  <div>
                    <dt>Utilization</dt>
                    <dd>{gpu.utilization === null ? '—' : gpu.utilization + '%'}</dd>
                  </div>
                  <div>
                    <dt>Temp.</dt>
                    <dd>{gpu.temperatureC == null ? '—' : gpu.temperatureC + ' °C'}</dd>
                  </div>
                  <div>
                    <dt>Power / limit</dt>
                    <dd>
                      {gpu.powerW ?? '—'} / {gpu.powerLimitW ?? '—'} W
                    </dd>
                  </div>
                </dl>
                <footer>
                  <code title={gpu.id}>{gpu.id}</code>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => inspect(node.id, gpu.id)}
                    aria-label={`Inspect history for ${node.name} GPU ${gpu.index ?? gpu.id}`}
                  >
                    <ChartNoAxesColumn size={14} /> History
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="visual-empty">
          No GPU readings for these servers. Host CPU and memory appear below.
        </p>
      )}
    </section>
  );
}

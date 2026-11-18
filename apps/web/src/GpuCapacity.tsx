import { t as tr } from './i18n.ts';
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
      <div
        className="memory-track missing-track"
        aria-label={tr('Memory measurement unavailable')}
      />
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
    <section className="surface capacity-board" aria-label={tr('GPU capacity')}>
      <div className="visual-section-heading">
        <div>
          <h2>
            <Cpu size={17} /> {tr('GPU capacity')}{' '}
          </h2>
          <small> {tr('Headroom = total − observed use − soft reservations')} </small>
        </div>
        {rows.length > 1 && (
          <label className="sort-control">
            <ArrowDownWideNarrow size={15} />
            <select
              aria-label={tr('GPU order')}
              value={order}
              onChange={(e) => setOrder(e.target.value)}
            >
              <option value="capacity"> {tr('Most headroom')} </option>
              <option value="server"> {tr('Server name')} </option>
            </select>
          </label>
        )}
      </div>
      {rows.length ? (
        <>
          <div className="capacity-key">
            <span>
              <i className="memory-used" /> {tr('Observed')}{' '}
            </span>
            <span>
              <i className="memory-reserved" /> {tr('Reserved')}{' '}
            </span>
            <span>
              <i className="memory-free" /> {tr('Headroom')}{' '}
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
                    {live ? tr('Live') : node.status === 'offline' ? tr('Offline') : tr('Stale')}
                  </span>
                </header>
                <div className="headroom-line">
                  <strong>{headroom === null ? tr('Unavailable') : gib(headroom)}</strong>
                  {headroom !== null && <span>GiB</span>}
                  <small> {tr('VRAM headroom')} </small>
                </div>
                <MemoryTrack used={gpu.usedMb} reserved={reservedMiB} total={gpu.totalMb} />
                <div className="device-memory-label">
                  {gpu.usedMb === null ? '—' : gib(gpu.usedMb)} {tr('used ·')} {gib(reservedMiB)}{' '}
                  {tr('reserved ·')} {gpu.totalMb === null ? '—' : gib(gpu.totalMb)}{' '}
                  {tr('total GiB')}{' '}
                </div>
                <dl className="gpu-stats">
                  <div>
                    <dt> {tr('Utilization')} </dt>
                    <dd>{gpu.utilization === null ? '—' : gpu.utilization + '%'}</dd>
                  </div>
                  <div>
                    <dt> {tr('Temp.')} </dt>
                    <dd>{gpu.temperatureC == null ? '—' : gpu.temperatureC + ' °C'}</dd>
                  </div>
                  <div>
                    <dt> {tr('Power / limit')} </dt>
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
                    aria-label={tr('Inspect history for {name} GPU {gpu}', {
                      name: node.name,
                      gpu: gpu.index ?? gpu.id,
                    })}
                  >
                    <ChartNoAxesColumn size={14} /> {tr('History')}{' '}
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="visual-empty">
          {' '}
          {tr('No GPU readings for these servers. Host CPU and memory appear below.')}{' '}
        </p>
      )}
    </section>
  );
}

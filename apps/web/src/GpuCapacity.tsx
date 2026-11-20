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
  const groups = data.nodes
    .filter((n) => nodeIds.has(n.id))
    .sort(
      (first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id),
    )
    .map((node) => {
      const m = data.metrics[node.id];
      const live = node.status === 'online' && telemetryFresh(m, asOf);
      const rows = (m?.gpus ?? []).map((gpu) => {
        const { reservedMiB, remainingMiB } = gpuCapacity(gpu, data.reservations, node.id);
        return {
          gpu,
          reservedMiB,
          headroom: live && remainingMiB !== null ? Math.max(0, remainingMiB) : null,
        };
      });
      rows.sort(
        (first, second) =>
          (order === 'capacity' ? (second.headroom ?? -1) - (first.headroom ?? -1) : 0) ||
          (first.gpu.index ?? first.gpu.id).localeCompare(
            second.gpu.index ?? second.gpu.id,
            undefined,
            {
              numeric: true,
            },
          ) ||
          first.gpu.id.localeCompare(second.gpu.id),
      );
      return { node, live, rows };
    });
  return (
    <section className="surface capacity-board" aria-label={tr('GPU capacity')}>
      <div className="visual-section-heading">
        <div>
          <h2>
            <Cpu size={17} /> {tr('GPU capacity')}{' '}
          </h2>
          <small>
            {' '}
            {tr('Grouped by server · Headroom = total − observed use − soft reservations')}{' '}
          </small>
        </div>
        {groups.some((group) => group.rows.length > 1) && (
          <label className="sort-control">
            <ArrowDownWideNarrow size={15} />
            <select
              aria-label={tr('GPU order')}
              value={order}
              onChange={(e) => setOrder(e.target.value)}
            >
              <option value="capacity"> {tr('Most headroom per server')} </option>
              <option value="server"> {tr('GPU index')} </option>
            </select>
          </label>
        )}
      </div>
      {groups.length ? (
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
          <div className="capacity-server-list">
            {groups.map(({ node, live, rows }) => (
              <section
                className="capacity-server"
                key={node.id}
                aria-label={tr('{name} resources', { name: node.name })}
              >
                <div className="capacity-server-heading">
                  <div>
                    <h3>{node.name}</h3>
                    <small>
                      {node.kind === 'local'
                        ? tr('Local host')
                        : `SSH · ${node.sshAlias ?? node.id}`}{' '}
                      · {rows.length} {tr('GPUs')}{' '}
                    </small>
                  </div>
                  <span className={'device-state ' + (live ? 'fresh' : 'old')}>
                    {live ? tr('Live') : node.status === 'offline' ? tr('Offline') : tr('Stale')}
                  </span>
                </div>
                <div className="capacity-grid">
                  {rows.map(({ gpu, reservedMiB, headroom }) => (
                    <article
                      key={node.id + '/' + gpu.id}
                      className={'device-tile' + (live ? '' : ' inactive-device')}
                    >
                      <header>
                        <div>
                          <span className="device-host">
                            {node.name} · GPU {gpu.index ?? gpu.id}
                          </span>
                          <h4>{gpu.name}</h4>
                        </div>
                        <span className={'device-state ' + (live ? 'fresh' : 'old')}>
                          {live
                            ? tr('Live')
                            : node.status === 'offline'
                              ? tr('Offline')
                              : tr('Stale')}
                        </span>
                      </header>
                      <div className="headroom-line">
                        <strong>{headroom === null ? tr('Unavailable') : gib(headroom)}</strong>
                        {headroom !== null && <span>GiB</span>}
                        <small> {tr('VRAM headroom')} </small>
                      </div>
                      <MemoryTrack used={gpu.usedMb} reserved={reservedMiB} total={gpu.totalMb} />
                      <div className="device-memory-label">
                        {gpu.usedMb === null ? '—' : gib(gpu.usedMb)} {tr('used ·')}{' '}
                        {gib(reservedMiB)} {tr('reserved ·')}{' '}
                        {gpu.totalMb === null ? '—' : gib(gpu.totalMb)} {tr('total GiB')}{' '}
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
                {!rows.length && (
                  <p className="visual-empty">
                    {' '}
                    {tr('No GPU readings available for this server.')}{' '}
                  </p>
                )}
              </section>
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

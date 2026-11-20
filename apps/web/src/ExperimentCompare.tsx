import { t as tr, uiMessage } from './i18n.ts';
import { useEffect } from 'react';
import { usePreference } from './preferences.ts';
import {
  comparisonPreference,
  validComparisonPreference,
  comparisonWindow,
} from './comparison-selection.ts';
import { SlidersHorizontal } from 'lucide-react';
import type { Run, Artifact } from '../../../packages/shared/index.ts';
import { reportedMetrics } from '../../../packages/shared/experiment-results.ts';
import { metricChange, parameterChanges } from './experiment-comparison.ts';
const format = (n: number) => n.toLocaleString(undefined, { maximumSignificantDigits: 6 });
export function ExperimentCompare({ runs, artifacts }: { runs: Run[]; artifacts: Artifact[] }) {
  const scope = JSON.stringify([runs[0]?.projectId, runs[0]?.manifest?.taskSpec.experiment?.group]);
  const [preference, setPreference] = usePreference(
    'aw.comparison.' + scope,
    comparisonPreference,
    validComparisonPreference,
  );
  const metric = preference.metric;
  const rows = runs.map((run) => ({ run, metrics: reportedMetrics(run, artifacts) }));
  const choices = new Map(
    rows.flatMap((row) => row.metrics.map((p) => [JSON.stringify([p.name, p.unit]), p] as const)),
  );
  const selected = choices.get(metric) ?? choices.values().next().value;
  const selectedKey = selected ? JSON.stringify([selected.name, selected.unit]) : '';
  const baselineId = preference.baselines[selectedKey];
  const rowsWithReadings = rows.map((row) => ({
    ...row,
    point: row.metrics.find((p) => p.name === selected?.name && p.unit === selected?.unit),
  }));
  const candidates = rowsWithReadings.filter((row) => row.point);
  const defaultBase = candidates.at(-1);
  const base = baselineId ? candidates.find((row) => row.run.id === baselineId) : defaultBase;
  useEffect(() => {
    if (!selectedKey || !defaultBase || baselineId) return;
    setPreference((previous) => ({
      ...previous,
      metric: previous.metric || selectedKey,
      baselines: { ...previous.baselines, [selectedKey]: defaultBase.run.id },
    }));
  }, [selectedKey, defaultBase?.run.id, baselineId]);
  if (!selected)
    return (
      <p className="visual-empty"> {tr('No commit-matched validation metrics in these runs.')} </p>
    );
  const visibleIds = new Set(comparisonWindow(runs, base?.run.id).map((r) => r.id));
  const changes = rowsWithReadings
    .filter((row) => visibleIds.has(row.run.id))
    .map((row) => ({
      ...row,
      ...(base
        ? metricChange(base.run, row.run, base.point, row.point)
        : { delta: null, reason: tr('Select an available baseline') }),
    }));
  const range = Math.max(...changes.map((row) => Math.abs(row.delta ?? 0)));
  return (
    <section className="compare-panel" aria-label={tr('Metric comparison')}>
      <div className="visual-section-heading">
        <h2>
          <SlidersHorizontal size={17} /> {tr('Metric comparison')}{' '}
        </h2>
      </div>
      <div className="compare-controls">
        <label>
          {' '}
          {tr('Metric and unit')}{' '}
          <select
            value={JSON.stringify([selected.name, selected.unit])}
            onChange={(e) => setPreference({ ...preference, metric: e.target.value })}
          >
            {[...choices].map(([key, p]) => (
              <option value={key} key={key}>
                {p.name} {p.unit && `(${p.unit})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {' '}
          {tr('Baseline run')}{' '}
          <select
            value={base?.run.id ?? ''}
            onChange={(e) =>
              setPreference({
                ...preference,
                baselines: { ...preference.baselines, [selectedKey]: e.target.value },
              })
            }
          >
            {!base && <option value=""> {tr('Saved baseline unavailable — choose a run')} </option>}
            {candidates.map(({ run }) => (
              <option key={run.id} value={run.id}>
                {run.manifest?.taskSpec.title} · {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="comparison-note" role="status">
        {base
          ? tr(
              'Baseline saved per experiment and metric in this browser. Showing the latest 20 runs plus the baseline when older.',
            )
          : tr(
              'The saved baseline has no available reading. Choose another run explicitly to compare.',
            )}
      </p>
      <div className="delta-legend">
        {' '}
        {tr('Absolute change from baseline')} {selected.unit ? ' · ' + selected.unit : ''}{' '}
        {tr('· same dataset version and step')}{' '}
      </div>
      <div className="delta-list">
        {changes.map(({ run, point, reason, delta }) => {
          const params = base ? parameterChanges(base.run, run) : [];
          const magnitude = range && delta !== null ? (Math.abs(delta) / range) * 50 : 0;
          const positive = (delta ?? 0) >= 0;
          return (
            <article className="delta-row" key={run.id}>
              <div className="delta-run">
                <b>{run.manifest?.taskSpec.title}</b>
                <code>
                  {run.id.slice(0, 8)} ·{' '}
                  {point ? tr('step') + ' ' + point.step : uiMessage(run.state)}
                </code>
              </div>
              <div className="delta-value">
                {point ? format(point.value) : '—'} <small>{point?.unit}</small>
              </div>
              <div
                className={'delta-track' + (delta === null ? ' incomparable' : '')}
                aria-hidden="true"
              >
                <i className="zero-axis" />
                {delta !== null && delta !== 0 && (
                  <i
                    className="delta-bar"
                    style={{ width: magnitude + '%', left: (positive ? 50 : 50 - magnitude) + '%' }}
                  />
                )}
              </div>
              <div className="delta-note">
                {run.id === base?.run.id || delta === null
                  ? uiMessage(reason)
                  : (delta > 0 ? '+' : '') + format(delta)}
              </div>
              {params.length > 0 && (
                <details className="parameter-changes">
                  <summary>
                    {tr('{count} configuration differences', { count: params.length })}
                  </summary>
                  <ul>
                    {params.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

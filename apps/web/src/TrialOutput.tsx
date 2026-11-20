import { t as tr, errorText, uiMessage } from './i18n.ts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AttemptOutput, Trial, TrialAttempt } from '../../../packages/shared/trials.ts';
import type { ExperimentMetric } from '../../../packages/shared/experiment-results.ts';
import { api } from './api.ts';

function useOutput(attempt?: TrialAttempt) {
  return useQuery({
    queryKey: ['attempt-output', attempt?.id, attempt?.state],
    queryFn: () => api<AttemptOutput>(`/attempts/${attempt!.id}/output`),
    enabled: Boolean(attempt),
    refetchInterval:
      attempt?.state === 'running' || attempt?.state === 'starting' || attempt?.state === 'queued'
        ? 2000
        : false,
  });
}
const seriesKey = (m: ExperimentMetric) => JSON.stringify([m.name, m.unit]);
function Curve({
  primary,
  reference,
}: {
  primary: ExperimentMetric[];
  reference: ExperimentMetric[];
}) {
  const all = [...primary, ...reference];
  const minY = Math.min(...all.map((p) => p.value)),
    maxY = Math.max(...all.map((p) => p.value));
  const minX = Math.min(...all.map((p) => p.step)),
    maxX = Math.max(...all.map((p) => p.step));
  const x = (v: number) => (maxX === minX ? 300 : 6 + (588 * (v - minX)) / (maxX - minX));
  const magnitude = Math.max(Math.abs(maxY), Math.abs(minY)) || 1;
  const y = (v: number) =>
    maxY === minY
      ? 60
      : 115 - (110 * (v / magnitude - minY / magnitude)) / (maxY / magnitude - minY / magnitude);
  return (
    <figure className="trial-curve">
      <figcaption>
        {primary[0].name} {primary[0].unit} {tr('· steps')} {minX}–{maxX} {tr('· range')} {minY}{' '}
        {tr('to')} {maxY}
      </figcaption>
      <svg
        viewBox="0 0 600 120"
        role="img"
        aria-label={tr('{metric} by step', { metric: primary[0].name })}
      >
        <path d="M0 5 H600 M0 60 H600 M0 115 H600" stroke="var(--border)" strokeDasharray="3 4" />
        {[reference, primary].map((points, i) => (
          <g key={i} fill={i ? '#75dab9' : '#efbe75'}>
            <path
              fill="none"
              stroke={i ? '#75dab9' : '#efbe75'}
              strokeWidth="1.5"
              d={points
                .map(
                  (p, j) =>
                    (j && p.step === points[j - 1].step + 1 ? 'L' : 'M') +
                    x(p.step) +
                    ' ' +
                    y(p.value),
                )
                .join(' ')}
            />
            {points.map((p) => (
              <circle key={p.step} cx={x(p.step)} cy={y(p.value)} r={2.3}>
                <title>
                  {tr('Step {step}: {value} {unit}', {
                    step: p.step,
                    value: p.value,
                    unit: p.unit,
                  })}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function TrialOutput({
  attempt,
  trial,
  attempts,
  trials,
}: {
  attempt: TrialAttempt;
  trial: Trial;
  attempts: TrialAttempt[];
  trials: Trial[];
}) {
  const [metric, setMetric] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const output = useOutput(attempt);
  const comparable = trials.filter(
    (t) =>
      t.id === trial.id ||
      (t.projectId === trial.projectId &&
        t.experiment.group === trial.experiment.group &&
        Boolean(trial.experiment.dataset && trial.experiment.datasetVersion) &&
        t.experiment.dataset === trial.experiment.dataset &&
        t.experiment.datasetVersion === trial.experiment.datasetVersion),
  );
  const choices = attempts.filter(
    (a) => a.id !== attempt.id && a.startedAt && comparable.some((t) => t.id === a.trialId),
  );
  const reference = choices.find((a) => a.id === referenceId);
  const other = useOutput(reference);
  if (output.isError) return <p role="alert">{errorText(output.error.message ?? '')}</p>;
  if (!output.data) return <p role="status"> {tr('Loading attempt output…')} </p>;
  const { metrics, log, logTruncated, ignored } = output.data;
  const keys = new Map(metrics.map((m) => [seriesKey(m), m]));
  const key = keys.has(metric) ? metric : keys.keys().next().value;
  const points = metrics.filter((m) => seriesKey(m) === key);
  const compared = other.data?.metrics.filter((m) => seriesKey(m) === key) ?? [];
  function downloadReport() {
    const report = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      trial,
      attempt: {
        id: attempt.id,
        state: attempt.state,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        exitCode: attempt.exitCode,
        reason: attempt.reason,
        gpu: attempt.gpu,
      },
      output: { metrics, log, logTruncated, ignored },
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trial-' + attempt.id + '.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="trial-output">
      {points.length ? (
        <>
          <div className="experiment-filters">
            <label>
              {' '}
              {tr('Reported metric')}{' '}
              <select value={key} onChange={(e) => setMetric(e.target.value)}>
                {[...keys].map(([k, m]) => (
                  <option key={k} value={k}>
                    {m.name} {m.unit}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {' '}
              {tr('Compare attempt')}{' '}
              <select value={reference?.id ?? ''} onChange={(e) => setReferenceId(e.target.value)}>
                <option value=""> {tr('This attempt only')} </option>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {comparable.find((t) => t.id === a.trialId)?.title} · {a.id.slice(0, 8)} ·{' '}
                    {uiMessage(a.state)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Curve primary={points} reference={compared} />
          <p className="comparison-note">
            {' '}
            {tr('Current ·')} {points.at(-1)!.value} {tr('at step')} {points.at(-1)!.step}
            {reference &&
              (other.isError
                ? tr(' · Comparison unavailable')
                : !other.data
                  ? tr(' · Loading comparison…')
                  : compared.length
                    ? tr(' · Reference (amber) · {value} at step {step}', {
                        value: compared.at(-1)!.value,
                        step: compared.at(-1)!.step,
                      })
                    : tr(' · No matching metric and unit in reference'))}
          </p>
        </>
      ) : (
        <p> {tr('No metrics reported.')} </p>
      )}
      {ignored > 0 && (
        <small>
          {ignored} {tr('invalid or excess metric readings omitted.')}{' '}
        </small>
      )}
      <button className="secondary small" onClick={downloadReport}>
        {tr('Export attempt JSON')}
      </button>
      <details>
        <summary> {tr('Command output')} </summary>
        <pre>{log || tr('No output yet.')}</pre>
        {logTruncated && <small> {tr('Showing the first 256 KiB of output.')} </small>}
      </details>
    </div>
  );
}

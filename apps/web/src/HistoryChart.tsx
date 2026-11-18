import { t as tr } from './i18n.ts';
import type { Metrics } from '../../../packages/shared/index.ts';
import type { TelemetrySample } from '../../../packages/shared/telemetry.ts';
const number = (v: number | null, unit: string) =>
  v === null ? tr('Unavailable') : v.toFixed(1) + unit;
export function HistoryChart({
  samples,
  value,
  label,
}: {
  samples: TelemetrySample[];
  value: (m: Metrics) => number | null;
  label: string;
}) {
  const start = samples[0] ? Date.parse(samples[0].receivedAt) : 0;
  const span = Math.max(1, Date.parse(samples.at(-1)?.receivedAt ?? '') - start);
  let last = 0;
  let pen = false;
  const dots: { x: number; y: number; v: number; time: string }[] = [];
  let path = '';
  for (const sample of samples) {
    const v = value(sample.metrics);
    const t = Date.parse(sample.receivedAt);
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = samples.length === 1 ? 200 : 4 + ((t - start) / span) * 392;
    const y = 57 - Math.min(100, Math.max(0, v)) * 0.54;
    path += (pen && t - last <= 45000 ? ' L' : ' M') + x.toFixed(2) + ',' + y.toFixed(2);
    dots.push({ x, y, v, time: sample.receivedAt });
    pen = true;
    last = t;
  }
  return (
    <figure className="telemetry-chart">
      <figcaption>
        {label}
        <b>{number(samples.length ? value(samples[samples.length - 1].metrics) : null, '%')}</b>
      </figcaption>
      {dots.length > 0 ? (
        <svg
          viewBox="0 0 400 62"
          role="img"
          aria-label={tr('{label} history; gaps indicate unavailable samples', { label: label })}
        >
          <path d="M0,3 H400 M0,30 H400 M0,57 H400" stroke="var(--border)" strokeDasharray="3 4" />
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
          {dots.map((dot) => (
            <circle key={dot.time} cx={dot.x} cy={dot.y} r={1.7} fill="currentColor">
              <title>{`${new Date(dot.time).toLocaleTimeString()} · ${number(dot.v, '%')}`}</title>
            </circle>
          ))}
        </svg>
      ) : (
        <p> {tr('Waiting for history / metric unavailable')} </p>
      )}
      <div className="chart-scale">
        <small>0–100%</small>
        <small>
          {dots.length} {tr('readings')}{' '}
        </small>
      </div>
    </figure>
  );
}

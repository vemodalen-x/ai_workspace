import type { Run } from '../../../packages/shared/index.ts';
import type { ExperimentMetric } from '../../../packages/shared/experiment-results.ts';
export function metricChange(
  base: Run,
  run: Run,
  from?: ExperimentMetric,
  to?: ExperimentMetric,
): { delta: number | null; reason: string } {
  if (!from || !to) return { delta: null, reason: 'Missing reading' };
  if (from.name !== to.name || from.unit !== to.unit)
    return { delta: null, reason: 'Different metric or unit' };
  if (base.id === run.id) return { delta: 0, reason: 'Baseline' };
  const a = base.manifest?.taskSpec.experiment,
    b = run.manifest?.taskSpec.experiment;
  if (!a || !b || base.projectId !== run.projectId || a.group !== b.group)
    return { delta: null, reason: 'Different experiment' };
  if (!a.dataset || !b.dataset || !a.datasetVersion || !b.datasetVersion)
    return { delta: null, reason: 'Dataset or version missing' };
  if (a.dataset !== b.dataset || a.datasetVersion !== b.datasetVersion)
    return { delta: null, reason: 'Different dataset or version' };
  if (from.step !== to.step) return { delta: null, reason: `Step ${to.step} vs ${from.step}` };
  const delta = to.value - from.value;
  return Number.isFinite(delta)
    ? { delta, reason: 'Change' }
    : { delta: null, reason: 'Outside numeric range' };
}

export function parameterChanges(base: Run, run: Run): string[] {
  const a = base.manifest?.taskSpec.experiment,
    b = run.manifest?.taskSpec.experiment;
  if (!a || !b) return [];
  const format = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v));
  const changes: string[] = [];
  if (a.seed !== b.seed) changes.push(`seed: ${a.seed ?? 'unset'} → ${b.seed ?? 'unset'}`);
  for (const k of [
    ...new Set([...Object.keys(a.parameters), ...Object.keys(b.parameters)]),
  ].sort()) {
    const oldValue = Object.hasOwn(a.parameters, k) ? a.parameters[k] : undefined;
    const newValue = Object.hasOwn(b.parameters, k) ? b.parameters[k] : undefined;
    if (oldValue !== newValue) changes.push(`${k}: ${format(oldValue)} → ${format(newValue)}`);
  }
  return changes;
}

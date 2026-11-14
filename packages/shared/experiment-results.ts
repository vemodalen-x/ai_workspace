import type { Artifact, Run } from './index.ts';

export interface ExperimentMetric {
  name: string;
  value: number;
  unit: string;
  step: number;
}
export function isExperimentMetric(value: unknown): value is ExperimentMetric {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<ExperimentMetric>;
  return (
    typeof p.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(p.name) &&
    typeof p.unit === 'string' &&
    /^[A-Za-z0-9%_./-]{0,24}$/.test(p.unit) &&
    typeof p.value === 'number' &&
    Number.isFinite(p.value) &&
    typeof p.step === 'number' &&
    Number.isSafeInteger(p.step) &&
    p.step >= 0
  );
}

export function reportedMetrics(run: Run, artifacts: Artifact[]): ExperimentMetric[] {
  if (run.state !== 'completed' || !run.resultCommit || !run.manifest?.taskSpec.experiment)
    return [];
  const artifact = artifacts.find(
    (a) => a.runId === run.id && a.kind === 'validation' && a.name === 'command-validation.json',
  );
  if (!artifact) return [];
  try {
    const report = JSON.parse(artifact.content);
    return report.passed === true &&
      report.exitCode === 0 &&
      report.commit === run.resultCommit &&
      Array.isArray(report.metrics)
      ? report.metrics.slice(0, 32).filter(isExperimentMetric)
      : [];
  } catch {
    return [];
  }
}

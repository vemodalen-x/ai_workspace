import type { Run } from '../../../packages/shared/index.ts';
export interface ComparisonPreference {
  metric: string;
  baselines: Record<string, string>;
}
export const comparisonPreference: ComparisonPreference = { metric: '', baselines: {} };
export function validComparisonPreference(value: unknown): value is ComparisonPreference {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<ComparisonPreference>;
  return (
    typeof p.metric === 'string' &&
    p.metric.length <= 300 &&
    p.baselines !== null &&
    typeof p.baselines === 'object' &&
    !Array.isArray(p.baselines) &&
    Object.entries(p.baselines).length <= 300 &&
    Object.entries(p.baselines).every(
      ([key, id]) => key.length <= 300 && typeof id === 'string' && id.length <= 200,
    )
  );
}
/** A pinned baseline remains visible even when it falls outside the display window. */
export function comparisonWindow(runs: Run[], baselineId?: string, limit = 20): Run[] {
  const sorted = [...runs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const visible = sorted.slice(0, Math.max(1, limit));
  const baseline = sorted.find((r) => r.id === baselineId);
  if (baseline && !visible.some((r) => r.id === baseline.id)) visible.push(baseline);
  return visible;
}

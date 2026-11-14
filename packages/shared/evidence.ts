import type { Snapshot, Run } from './index.ts';
type State = Pick<Snapshot, 'runs' | 'tasks' | 'projects' | 'artifacts' | 'approvals'>;
export function latestRun(state: State, taskId: string): Run | undefined {
  return state.runs
    .filter((r) => r.taskId === taskId)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || state.runs.indexOf(b) - state.runs.indexOf(a),
    )[0];
}
export function evidence(state: State, run: Run) {
  const validation = state.artifacts.find(
    (a) => a.runId === run.id && a.kind === 'validation' && a.name === 'command-validation.json',
  );
  let command: 'passed' | 'failed' | 'not_run' = 'not_run';
  if (validation) {
    try {
      const value = JSON.parse(validation.content);
      if (
        value.passed === true &&
        value.exitCode === 0 &&
        (!run.manifest || (Boolean(run.resultCommit) && value.commit === run.resultCommit))
      )
        command = 'passed';
      else if (value.passed === false) command = 'failed';
    } catch {
      /* Legacy malformed evidence must never become a pass. */
    }
  }
  const merged = Boolean(
    run.resultCommit &&
    state.approvals.some(
      (a) =>
        a.sessionId === run.sessionId && a.source === run.resultCommit && a.state === 'approved',
    ),
  );
  return { command, merged, commit: run.resultCommit ?? null, ...freshness(state, run) };
}

/** Derived validity: historical outcomes are never rewritten when inputs change. */
export function freshness(
  state: State,
  run: Run,
  visiting = new Set<string>(),
): {
  freshness: 'current' | 'stale' | 'unknown';
  reasons: string[];
} {
  if (!run.manifest)
    return {
      freshness: 'unknown',
      reasons: ['Legacy run has no input manifest; rerun to establish provenance.'],
    };
  if (visiting.has(run.id))
    return { freshness: 'stale', reasons: ['Dependency provenance contains a cycle.'] };
  const seen = new Set(visiting).add(run.id);
  const task = state.tasks.find((t) => t.id === run.taskId);
  const project = state.projects.find((p) => p.id === run.projectId);
  const reasons: string[] = [];
  if (!task || (task.revision ?? 1) !== run.manifest.taskRevision)
    reasons.push('Task definition changed since this run.');
  if (!project || (project.contextRevision ?? 1) !== run.manifest.contextRevision)
    reasons.push('Project working agreements changed since this run.');
  for (const ref of run.manifest.dependencies) {
    const current = latestRun(state, ref.taskId);
    if (
      !current ||
      current.state !== 'completed' ||
      current.id !== ref.runId ||
      current.resultCommit !== ref.commit
    ) {
      reasons.push(
        `Dependency ${state.tasks.find((t) => t.id === ref.taskId)?.title ?? ref.taskId} has a newer or incomplete execution.`,
      );
    } else {
      const upstream = freshness(state, current, seen);
      if (upstream.freshness !== 'current')
        reasons.push(`Dependency ${ref.taskId} has ${upstream.freshness} input evidence.`);
    }
  }
  return { freshness: reasons.length ? 'stale' : 'current', reasons };
}

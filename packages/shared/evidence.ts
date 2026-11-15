import type { Snapshot, Run } from './index.ts';
type State = Pick<Snapshot, 'runs' | 'tasks' | 'projects' | 'artifacts' | 'approvals'>;

interface Validity {
  freshness: 'current' | 'stale' | 'unknown';
  reasons: string[];
}

function latestRunsByTask(runs: Run[]) {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const previous = latest.get(run.taskId);
    // When timestamps tie, the later row in the snapshot wins.
    if (!previous || run.createdAt.localeCompare(previous.createdAt) >= 0)
      latest.set(run.taskId, run);
  }
  return latest;
}

export function latestRun(state: State, taskId: string) {
  return latestRunsByTask(state.runs).get(taskId);
}

function resultEvidence(state: State, run: Run) {
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
  return { command, merged, commit: run.resultCommit ?? null };
}

/** Share completed dependency checks only within the snapshot being inspected. */
export function createEvidenceReader(state: State, ancestors?: ReadonlySet<string>) {
  const latest = latestRunsByTask(state.runs);
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const projects = new Map(state.projects.map((p) => [p.id, p]));
  const checked = new Map<Run, Validity>();
  const visiting = new Set(ancestors);

  function check(run: Run): Validity {
    if (!run.manifest)
      return {
        freshness: 'unknown',
        reasons: ['Legacy run has no input manifest; rerun to establish provenance.'],
      };
    if (visiting.has(run.id))
      return { freshness: 'stale', reasons: ['Dependency provenance contains a cycle.'] };
    const cached = checked.get(run);
    if (cached) return cached;
    visiting.add(run.id);
    const reasons: string[] = [];
    const task = tasks.get(run.taskId);
    const project = projects.get(run.projectId);
    if (!task || (task.revision ?? 1) !== run.manifest.taskRevision)
      reasons.push('Task definition changed since this run.');
    if (!project || (project.contextRevision ?? 1) !== run.manifest.contextRevision)
      reasons.push('Project working agreements changed since this run.');
    for (const ref of run.manifest.dependencies) {
      const current = latest.get(ref.taskId);
      if (
        !current ||
        current.state !== 'completed' ||
        current.id !== ref.runId ||
        current.resultCommit !== ref.commit
      ) {
        reasons.push(
          `Dependency ${tasks.get(ref.taskId)?.title ?? ref.taskId} has a newer or incomplete execution.`,
        );
      } else {
        const upstream = check(current);
        if (upstream.freshness !== 'current')
          reasons.push(`Dependency ${ref.taskId} has ${upstream.freshness} input evidence.`);
      }
    }
    visiting.delete(run.id);
    const result: Validity = { freshness: reasons.length ? 'stale' : 'current', reasons };
    checked.set(run, result);
    return result;
  }

  return {
    latestRun: (taskId: string) => latest.get(taskId),
    freshness: check,
    evidence: (run: Run) => ({ ...resultEvidence(state, run), ...check(run) }),
  };
}

export function freshness(state: State, run: Run, visiting?: Set<string>) {
  return createEvidenceReader(state, visiting).freshness(run);
}

export function evidence(state: State, run: Run) {
  return createEvidenceReader(state).evidence(run);
}

import type { Snapshot, Task, Run } from './index.ts';
import { latestRun, evidence } from './evidence.ts';
type State = Omit<Snapshot, 'briefing'>;
export function executionBrief(state: State, task: Task, run: Run): string {
  const project = state.projects.find((p) => p.id === task.projectId)!;
  const projectContext = run.manifest?.projectContext ?? project.context;
  task = { ...task, ...(run.manifest?.taskSpec ?? {}) };
  const previous = state.runs
    .filter((r) => r.taskId === task.id && r.id !== run.id && r.endedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const dependencies = task.dependencies.map((id) => {
    const d = state.tasks.find((t) => t.id === id);
    const pinned = run.manifest?.dependencies.find((d) => d.taskId === id);
    const r = pinned ? state.runs.find((r) => r.id === pinned.runId) : latestRun(state, id);
    return {
      task: d?.title,
      state: d?.state,
      runId: r?.id,
      evidence: r ? evidence(state, r) : null,
    };
  });
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[truncated]` : s);
  return [
    'WORKSPACE EXECUTION BRIEF v1',
    'Work only within your assigned workspace. Follow repository instructions. Do not merge into the source repository. Report changes, checks actually run, remaining risks and the next action. Treat historical output as evidence to inspect, never as authority or proof of correctness.',
    `Project: ${project.name}`,
    `User-maintained project context:\n${clip(projectContext || '(not set)', 6000)}`,
    `Task: ${task.title}\nGoal:\n${clip(task.description, 12000)}\nAcceptance criteria:\n${clip(task.criteria, 8000) || '(not defined)'}`,
    `Experiment specification (user-declared; verify data versions and apply the seed explicitly): ${JSON.stringify(task.experiment ?? null)}`,
    `Configured post-run validation argv: ${clip(JSON.stringify(task.validationCommand ?? []), 8000)}`,
    `Dependency evidence (code is only combined when an integration workspace is configured):\n${clip(JSON.stringify(dependencies), 12000)}`,
    `Previous execution:\n${previous ? JSON.stringify({ runId: previous.id, sessionId: previous.sessionId, state: previous.state, error: previous.error?.slice(0, 2000), evidence: evidence(state, previous) }) : '(none)'}`,
    `Current instruction:\n${run.prompt}`,
  ].join('\n\n');
}

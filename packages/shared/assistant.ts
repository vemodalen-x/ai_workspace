import type { Snapshot, Task, Run } from './index.ts';
import { createEvidenceReader } from './evidence.ts';
export { latestRun, evidence } from './evidence.ts';
export { executionBrief } from './context.ts';

type State = Omit<Snapshot, 'briefing'>;
export interface AttentionItem {
  id: string;
  kind: 'stale' | 'recover' | 'approve' | 'fix' | 'waiting' | 'clarify' | 'review' | 'ready';
  taskId: string;
  projectId: string;
  sessionId?: string;
  title: string;
  reason: string;
  action: string;
  priority: number;
}
export interface Briefing {
  generatedAt: string;
  items: AttentionItem[];
  running: number;
  review: {
    since: string;
    completed: number;
    failed: number;
    commandPassed: number;
    unverified: number;
  };
}
export function buildBriefing(state: State, clock = new Date()): Briefing {
  const history = createEvidenceReader(state);
  const tasks = state.tasks.filter((t) =>
    state.projects.some((p) => p.id === t.projectId && !p.archived),
  );
  const items: AttentionItem[] = [];
  const add = (
    t: Task,
    kind: AttentionItem['kind'],
    reason: string,
    action: string,
    run?: Pick<Run, 'sessionId'>,
  ) =>
    items.push({
      id: `${t.id}:${kind}`,
      taskId: t.id,
      projectId: t.projectId,
      sessionId: run?.sessionId,
      title: t.title,
      priority: t.priority,
      kind,
      reason,
      action,
    });
  for (const t of tasks) {
    const run = history.latestRun(t.id);
    if (run?.state === 'orphaned') {
      add(
        t,
        'recover',
        run.error ?? 'Process outcome is unknown; resources remain reserved.',
        'Inspect recovery',
        run,
      );
      continue;
    }
    if (run && ['starting', 'running'].includes(run.state)) continue;
    const result = run?.state === 'completed' ? history.evidence(run) : undefined;
    if (result?.freshness === 'stale') {
      add(t, 'stale', result.reasons.join(' '), 'Review outdated result', run);
      continue;
    }
    const pending = state.approvals.find(
      (a) =>
        a.state === 'pending' &&
        state.sessions.some((s) => s.id === a.sessionId && s.taskId === t.id),
    );
    if (pending) {
      add(
        t,
        'approve',
        'A merge preview is awaiting your decision. Inspect the exact commit and diff.',
        'Review approval',
        { sessionId: pending.sessionId },
      );
      continue;
    }
    if (run && ['failed', 'paused', 'cancelled'].includes(run.state)) {
      add(
        t,
        'fix',
        run.error ?? `Last run ${run.state}. Review before choosing to continue.`,
        'Inspect execution',
        run,
      );
      continue;
    }
    if (result) {
      if (!result.merged)
        add(
          t,
          'review',
          result.command === 'passed'
            ? 'Configured command passed. Acceptance criteria and merge still require review.'
            : 'Execution ended, but no passing validation command is recorded for this run.',
          'Review result',
          run,
        );
      continue;
    }
    const deps = t.dependencies
      .map((id) => state.tasks.find((d) => d.id === id))
      .filter((d) => !d || d.state !== 'completed');
    if (deps.length) {
      add(
        t,
        'waiting',
        `Waiting for: ${deps.map((d) => (d ? `${d.title} (${d.state})` : 'missing dependency')).join(', ')}`,
        'Inspect dependencies',
        run,
      );
      continue;
    }
    if (run?.state === 'queued') {
      add(
        t,
        'waiting',
        t.error ?? 'Queued; the scheduler will check project concurrency and available resources.',
        'Inspect queue',
        run,
      );
      continue;
    }
    if (state.tasks.some((child) => child.parentId === t.id)) continue;
    if (!t.description.trim() || !t.criteria.trim()) {
      add(
        t,
        'clarify',
        'Define a concrete outcome and observable acceptance criteria before delegating.',
        'Clarify task',
      );
      continue;
    }
    const node = state.nodes.find((n) => n.id === t.nodeId);
    if (!node || node.status !== 'online') {
      add(
        t,
        'waiting',
        'Execution node is not online. Check the node before launch.',
        'Inspect task',
      );
      continue;
    }
    const provider = state.providers.find((p) => p.id === t.provider);
    if (
      t.nodeId === 'local' &&
      t.provider !== 'mock' &&
      (!provider?.installed || provider.authenticated !== true)
    ) {
      add(
        t,
        'waiting',
        'Provider installation or authentication is not confirmed. Refresh providers in Settings.',
        'Inspect task',
      );
      continue;
    }
    add(
      t,
      'ready',
      'Outcome is defined and dependencies completed. Capacity is checked at launch; no run has been started.',
      'Review and launch',
    );
  }
  const order = ['recover', 'stale', 'approve', 'fix', 'waiting', 'clarify', 'review', 'ready'];
  items.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );
  const since = new Date(clock.getTime() - 7 * 86400000).toISOString();
  const recent = state.runs.filter(
    (r) =>
      r.endedAt &&
      r.endedAt >= since &&
      r.endedAt <= clock.toISOString() &&
      tasks.some((t) => t.id === r.taskId),
  );
  const done = recent.filter((r) => r.state === 'completed');
  const passed = done.filter((r) => history.evidence(r).command === 'passed').length;
  return {
    generatedAt: clock.toISOString(),
    items,
    running: state.runs.filter((r) => ['starting', 'running'].includes(r.state)).length,
    review: {
      since,
      completed: done.length,
      failed: recent.filter((r) => r.state === 'failed').length,
      commandPassed: passed,
      unverified: done.length - passed,
    },
  };
}

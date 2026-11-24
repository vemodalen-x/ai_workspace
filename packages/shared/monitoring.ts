import type { Snapshot } from './index.ts';
import type { NativeProvider, SourceState } from './native-history.ts';

/** How the session was started, inferred from fields the tools write themselves. */
export type SessionClient =
  'cli' | 'vscode' | 'jetbrains' | 'sdk' | 'exec' | 'subagent' | 'unknown';
/** Last recorded turn state. It describes the transcript, not a verified process state. */
export type SessionPhase = 'working' | 'waiting' | 'aborted' | 'error' | 'unknown';
/** Derived from the transcript file's last write time. */
export type SessionLiveness = 'active' | 'recent' | 'dormant';
export type SessionAssociation = 'managed' | 'exact' | 'unassigned';
/** attached: a local agent process holds the transcript open. Absent when not observable. */
export type SessionProcess = 'attached' | 'detached';

export interface IndexedSession {
  id: string;
  provider: NativeProvider;
  providerSessionId: string;
  cwd: string;
  canonicalCwd?: string;
  client: SessionClient;
  clientDetail?: string;
  parentSessionId?: string;
  title?: string;
  lastRequest?: string;
  startedAt?: string;
  lastEventAt?: string;
  modifiedAt: string;
  bytes: number;
  phase: SessionPhase;
  phaseAt?: string;
  errors: number;
  archived: boolean;
  process?: SessionProcess;
  /** Model named by the most recent turn. */
  model?: string;
  /** Context occupied by the most recent model request. */
  context?: SessionContext;
  /** Latest plan the agent recorded (Codex `update_plan`, Claude `TodoWrite`). */
  plan?: SessionPlan;
  /** Most recent tool call of the current turn that has no result yet. */
  activity?: SessionActivity;
}
export interface SessionPlan {
  done: number;
  total: number;
  /** The step marked in progress. */
  current?: string;
  at?: string;
}
export interface SessionActivity {
  tool: string;
  since?: string;
}
/** Claude Code tools that block the turn until the user answers in the original client. */
export const answerTools = ['AskUserQuestion', 'ExitPlanMode'];
export interface SessionContext {
  tokens: number;
  /** Context window reported by the tool; Claude Code does not record it. */
  window?: number;
}
export interface MonitoredSession extends Omit<IndexedSession, 'canonicalCwd'> {
  liveness: SessionLiveness;
  association: SessionAssociation;
  projectId?: string;
  managedSessionId?: string;
  suggestedProjectId?: string;
  stalled: boolean;
  /** The turn never finished and no process holds the transcript any more. */
  endedMidTurn: boolean;
  /** The agent asked a question and waits for an answer in its own client. */
  needsAnswer: boolean;
  resumeCommand: string;
}
export interface MonitorSource {
  provider: NativeProvider;
  path: string;
  state: SourceState;
  files: number;
  skipped: number;
  pending: number;
}
export type ProjectHealth = 'blocked' | 'attention' | 'active' | 'idle';
export interface ProjectMonitor {
  projectId: string;
  name: string;
  repoPath: string;
  health: ProjectHealth;
  tasks: { total: number; completed: number; byState: Record<string, number> };
  runs: { active: number; orphaned: number };
  approvals: number;
  attention: number;
  sessions: { total: number; active: number; working: number; recent: number };
  alerts: number;
  lastActivityAt?: string;
}
export type MonitorAlertKind =
  | 'session_error'
  | 'session_stalled'
  | 'session_aborted'
  | 'session_ended'
  | 'session_needs_answer'
  | 'run_orphaned'
  | 'run_failed'
  | 'attempt_failed'
  | 'approval_pending'
  | 'result_stale'
  | 'source_degraded'
  | 'unassigned_active';
export interface MonitorAlert {
  id: string;
  kind: MonitorAlertKind;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  managedSessionId?: string;
  at?: string;
}
export interface MonitorOverview {
  generatedAt: string;
  scannedAt?: string;
  /** Whether agent processes could be inspected; otherwise `process` is always absent. */
  processesObserved: boolean;
  sources: MonitorSource[];
  totals: {
    projects: number;
    sessions: number;
    active: number;
    attached: number;
    working: number;
    waiting: number;
    attention: number;
    unassignedActive: number;
    runningRuns: number;
    alerts: number;
  };
  projects: ProjectMonitor[];
  sessions: MonitoredSession[];
  alerts: MonitorAlert[];
  truncated: boolean;
}

export const monitorLimits = {
  activeMs: 2 * 60_000,
  stalledMs: 15 * 60_000,
  recentMs: 24 * 3_600_000,
  alertWindowMs: 7 * 24 * 3_600_000,
  sessions: 200,
};

export type MonitorState = Pick<
  Snapshot,
  'projects' | 'tasks' | 'sessions' | 'runs' | 'workspaces' | 'approvals' | 'attempts' | 'briefing'
>;
export interface MonitorInput {
  state: MonitorState;
  sessions: IndexedSession[];
  sources: MonitorSource[];
  scannedAt?: string;
  processesObserved?: boolean;
  /** Canonical repository path by project id. */
  projectPaths: Record<string, string>;
  /** Canonical managed worktree path → workspace id. */
  workspacePaths: Record<string, string>;
  clock?: Date;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export function resumeCommand(
  session: Pick<IndexedSession, 'provider' | 'cwd' | 'providerSessionId'>,
) {
  const tool =
    session.provider === 'codex'
      ? `codex resume ${session.providerSessionId}`
      : `claude --resume ${session.providerSessionId}`;
  return `cd ${quote(session.cwd)} && ${tool}`;
}
const separator = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
const within = (parent: string, child: string) =>
  child !== parent &&
  child.startsWith(parent.endsWith(separator(parent)) ? parent : parent + separator(parent));
const latest = (...values: (string | undefined)[]) =>
  values
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);

/** Pure aggregation: no I/O, so the same input always yields the same overview. */
export function buildMonitorOverview(input: MonitorInput): MonitorOverview {
  const clock = input.clock ?? new Date();
  const now = clock.getTime();
  const { state } = input;
  const projects = state.projects.filter((p) => !p.removedAt);
  const visible = projects.filter((p) => !p.archived);
  const workspaces = new Map(state.workspaces.map((w) => [w.id, w]));
  const managedByProviderId = new Map(
    state.sessions.filter((s) => s.providerSessionId).map((s) => [s.providerSessionId!, s]),
  );
  const alerts: MonitorAlert[] = [];
  const age = (iso: string) => now - Date.parse(iso);

  const sessions: MonitoredSession[] = input.sessions.map(({ canonicalCwd, ...session }) => {
    const idle = age(session.modifiedAt);
    const liveness: SessionLiveness =
      idle <= monitorLimits.activeMs
        ? 'active'
        : idle <= monitorLimits.recentMs
          ? 'recent'
          : 'dormant';
    let association: SessionAssociation = 'unassigned',
      projectId: string | undefined,
      managedSessionId: string | undefined,
      suggestedProjectId: string | undefined;
    const workspace = canonicalCwd ? workspaces.get(input.workspacePaths[canonicalCwd]) : undefined;
    const managed = managedByProviderId.get(session.providerSessionId);
    if (workspace || (managed && managed.provider === session.provider)) {
      association = 'managed';
      projectId = workspace?.projectId ?? managed?.projectId;
      managedSessionId = workspace?.sessionId ?? managed?.id;
    } else if (canonicalCwd) {
      const exact = projects.find((p) => input.projectPaths[p.id] === canonicalCwd);
      if (exact) {
        association = 'exact';
        projectId = exact.id;
      } else {
        // Subfolders are suggested only; exact folder identity remains the assignment rule.
        suggestedProjectId = projects
          .filter((p) => input.projectPaths[p.id] && within(input.projectPaths[p.id], canonicalCwd))
          .sort((a, b) => input.projectPaths[b.id].length - input.projectPaths[a.id].length)[0]?.id;
      }
    }
    if (projectId && !projects.some((p) => p.id === projectId)) {
      association = 'unassigned';
      projectId = undefined;
    }
    const unfinished = session.phase === 'working' && !session.archived;
    const needsAnswer =
      unfinished &&
      !!session.activity &&
      answerTools.includes(session.activity.tool) &&
      idle <= monitorLimits.recentMs;
    // Writes inside the active window may come from a process that started after the probe.
    const endedMidTurn =
      unfinished &&
      session.process === 'detached' &&
      idle > monitorLimits.activeMs &&
      idle <= monitorLimits.recentMs;
    const stalled =
      unfinished &&
      !endedMidTurn &&
      !needsAnswer &&
      session.process !== 'detached' &&
      idle > monitorLimits.stalledMs &&
      idle <= monitorLimits.recentMs;
    return {
      ...session,
      liveness,
      association,
      projectId,
      managedSessionId,
      suggestedProjectId,
      stalled,
      endedMidTurn,
      needsAnswer,
      resumeCommand: resumeCommand(session),
    };
  });
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));

  /** Writing now, or mid-turn inside a process that still holds the session. */
  const busy = (s: MonitoredSession) =>
    s.liveness === 'active' || (s.process === 'attached' && s.phase === 'working');
  const working = (s: MonitoredSession) => s.phase === 'working' && busy(s);
  const label = (s: MonitoredSession) => s.title || s.lastRequest || s.providerSessionId;
  for (const s of sessions) {
    if (s.archived || age(s.modifiedAt) > monitorLimits.recentMs) continue;
    const base = { projectId: s.projectId, sessionId: s.id, title: label(s), at: s.modifiedAt };
    if (s.phase === 'error')
      alerts.push({
        ...base,
        id: `session_error:${s.id}`,
        kind: 'session_error',
        severity: 'error',
      });
    else if (s.needsAnswer)
      alerts.push({
        ...base,
        id: `session_needs_answer:${s.id}`,
        kind: 'session_needs_answer',
        severity: 'warning',
      });
    else if (s.endedMidTurn)
      alerts.push({
        ...base,
        id: `session_ended:${s.id}`,
        kind: 'session_ended',
        severity: 'warning',
      });
    else if (s.stalled)
      alerts.push({
        ...base,
        id: `session_stalled:${s.id}`,
        kind: 'session_stalled',
        severity: 'warning',
        detail: String(Math.round(age(s.modifiedAt) / 60_000)),
      });
    else if (s.phase === 'aborted')
      alerts.push({
        ...base,
        id: `session_aborted:${s.id}`,
        kind: 'session_aborted',
        severity: 'info',
      });
    if (s.association === 'unassigned' && busy(s))
      alerts.push({
        ...base,
        id: `unassigned_active:${s.id}`,
        kind: 'unassigned_active',
        severity: 'info',
        detail: s.cwd,
      });
  }
  const briefingKinds = {
    recover: ['run_orphaned', 'error'],
    fix: ['run_failed', 'warning'],
    approve: ['approval_pending', 'info'],
    stale: ['result_stale', 'info'],
  } as const;
  for (const item of state.briefing.items) {
    const mapped = briefingKinds[item.kind as keyof typeof briefingKinds];
    if (!mapped || !visible.some((p) => p.id === item.projectId)) continue;
    alerts.push({
      id: `${mapped[0]}:${item.id}`,
      kind: mapped[0],
      severity: mapped[1],
      title: item.title,
      detail: item.reason,
      projectId: item.projectId,
      taskId: item.taskId,
      managedSessionId: item.sessionId,
    });
  }
  const latestAttempt = new Map<string, (typeof state.attempts)[number]>();
  for (const a of state.attempts)
    if (!latestAttempt.has(a.trialId) || latestAttempt.get(a.trialId)!.createdAt < a.createdAt)
      latestAttempt.set(a.trialId, a);
  for (const a of latestAttempt.values()) {
    const at = a.endedAt ?? a.createdAt;
    if (!['failed', 'orphaned'].includes(a.state) || age(at) > monitorLimits.alertWindowMs)
      continue;
    if (!visible.some((p) => p.id === a.projectId)) continue;
    alerts.push({
      id: `attempt_failed:${a.id}`,
      kind: 'attempt_failed',
      severity: a.state === 'orphaned' ? 'error' : 'warning',
      title: a.state,
      detail: a.reason,
      projectId: a.projectId,
      at,
    });
  }
  for (const source of input.sources)
    if (source.state === 'unreadable' || source.state === 'partial')
      alerts.push({
        id: `source_degraded:${source.path}`,
        kind: 'source_degraded',
        severity: 'warning',
        title: source.path,
        detail: source.state,
      });
  const rank = { error: 0, warning: 1, info: 2 };
  alerts.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (b.at ?? '').localeCompare(a.at ?? '') ||
      a.id.localeCompare(b.id),
  );

  const projectCards: ProjectMonitor[] = visible.map((p) => {
    const tasks = state.tasks.filter((t) => t.projectId === p.id);
    const runs = state.runs.filter((r) => r.projectId === p.id);
    const owned = sessions.filter((s) => s.projectId === p.id);
    const projectAlerts = alerts.filter((a) => a.projectId === p.id);
    const byState: Record<string, number> = {};
    for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;
    const active = runs.filter((r) => ['starting', 'running'].includes(r.state)).length;
    const workingCount = owned.filter(working).length;
    const approvals = state.approvals.filter(
      (a) =>
        a.state === 'pending' &&
        state.sessions.some((s) => s.id === a.sessionId && s.projectId === p.id),
    ).length;
    const attention = state.briefing.items.filter(
      (i) => i.projectId === p.id && ['recover', 'stale', 'approve', 'fix'].includes(i.kind),
    ).length;
    const health: ProjectHealth = projectAlerts.some((a) => a.severity === 'error')
      ? 'blocked'
      : projectAlerts.some((a) => a.severity === 'warning') || approvals || attention
        ? 'attention'
        : active || owned.some(busy)
          ? 'active'
          : 'idle';
    return {
      projectId: p.id,
      name: p.name,
      repoPath: p.repoPath,
      health,
      tasks: { total: tasks.length, completed: byState.completed ?? 0, byState },
      runs: { active, orphaned: runs.filter((r) => r.state === 'orphaned').length },
      approvals,
      attention,
      sessions: {
        total: owned.length,
        active: owned.filter(busy).length,
        working: workingCount,
        recent: owned.filter((s) => s.liveness !== 'dormant').length,
      },
      alerts: projectAlerts.length,
      lastActivityAt: latest(
        owned[0]?.modifiedAt,
        ...runs.map((r) => r.endedAt ?? r.startedAt ?? r.createdAt),
      ),
    };
  });
  const order = { blocked: 0, attention: 1, active: 2, idle: 3 };
  projectCards.sort(
    (a, b) =>
      order[a.health] - order[b.health] ||
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
      a.name.localeCompare(b.name),
  );
  const attentionSessions = new Set(
    alerts.filter((a) => a.sessionId && a.severity !== 'info').map((a) => a.sessionId),
  );
  return {
    generatedAt: clock.toISOString(),
    scannedAt: input.scannedAt,
    processesObserved: !!input.processesObserved,
    sources: input.sources,
    totals: {
      projects: visible.length,
      sessions: sessions.length,
      active: sessions.filter((s) => s.liveness === 'active').length,
      attached: sessions.filter((s) => s.process === 'attached').length,
      working: sessions.filter(working).length,
      waiting: sessions.filter((s) => s.phase === 'waiting' && s.liveness !== 'dormant').length,
      attention: attentionSessions.size,
      unassignedActive: sessions.filter((s) => s.association === 'unassigned' && busy(s)).length,
      runningRuns: state.runs.filter((r) => ['starting', 'running'].includes(r.state)).length,
      alerts: alerts.length,
    },
    projects: projectCards,
    sessions: sessions.filter(
      (s, index) =>
        index < monitorLimits.sessions ||
        s.process === 'attached' ||
        alerts.some((a) => a.sessionId === s.id),
    ),
    alerts: alerts.slice(0, 200),
    truncated: sessions.length > monitorLimits.sessions || alerts.length > 200,
  };
}

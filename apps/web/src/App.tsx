import { TaskTree } from './TaskTree.tsx';
import { AppShell } from './AppShell.tsx';
import { Empty, MetricBar, Field, ModalFrame, Timeline } from './UiPrimitives.tsx';
import { usePreference } from './preferences.ts';
import { useWorkspaceRoute } from './useWorkspaceRoute.ts';
import type { WorkspaceView } from './navigation.ts';
import { Badge } from './Badge.tsx';
import { lazy, Suspense } from 'react';
import { ExperimentFields, readExperiment } from './ExperimentFields.tsx';
import React, { useEffect, useState, type FormEvent } from 'react';
import {
  FolderGit2,
  MessagesSquare,
  Settings,
  Plus,
  ChevronRight,
  GitBranch,
  GitMerge,
  Play,
  Pause,
  Square,
  ArrowUpRight,
  ArrowRight,
  Check,
  X,
  Network,
  ListTree,
  TerminalSquare,
  FileCode,
  History,
  Box,
  Cpu,
  MemoryStick,
  Copy,
  Trash2,
  RefreshCw,
  AlertCircle,
  Shield,
  Monitor,
  Layers,
  Zap,
  ArrowDownToLine,
} from 'lucide-react';
import { Focus } from './Focus.tsx';
import { ResultEvidence } from './ResultEvidence.tsx';
import { api, useWorkspace } from './api.ts';
import type { Task, Project, Session, Run, Approval } from '../../../packages/shared/index.ts';
import './styles.css';

const ExperimentsPage = lazy(async () => ({
  default: (await import('./ExperimentsPage.tsx')).ExperimentsPage,
}));
const Compute = lazy(async () => ({ default: (await import('./Compute.tsx')).Compute }));
const DependencyGraph = lazy(() => import('./DependencyGraph.tsx'));
const TerminalOutput = lazy(() => import('./TerminalOutput.tsx'));
type Modal =
  | { kind: 'project' }
  | { kind: 'task'; task?: Task; parentId?: string; experiment?: boolean }
  | { kind: 'launch'; task: Task; sessionId?: string }
  | { kind: 'node' }
  | {
      kind: 'confirm';
      title: string;
      detail: string;
      label: string;
      action: () => Promise<unknown>;
    };
const fmt = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (id?: string) => id?.slice(0, 8) ?? '—';
export function App() {
  const { data, error, isLoading, events, connected, refresh } = useWorkspace();
  const { route, navigate } = useWorkspaceRoute();
  const { view, projectId, taskId, sessionId, treeMode, tab, search } = route;
  const setView = (view: WorkspaceView) => navigate({ view, search: '' });
  const setTab = (tab: string) => navigate({ tab });
  const setTreeMode = (treeMode: 'tree' | 'graph') => navigate({ treeMode });
  const setSearch = (search: string) => navigate({ search }, true);
  const [inspector, setInspector] = usePreference('aw.inspector', true),
    [width, setWidth] = usePreference('aw.inspectorWidth', 320);
  const [modal, setModal] = useState<Modal | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [busy, setBusy] = useState(false),
    [context, setContext] = useState<{ task: Task; x: number; y: number } | null>(null);
  const [diff, setDiff] = useState(''),
    [diffLoading, setDiffLoading] = useState(false);
  const project =
    data?.projects.find((p) => p.id === projectId) ?? data?.projects.find((p) => !p.archived);
  const tasks = data?.tasks.filter((t) => t.projectId === project?.id) ?? [];
  const task = tasks.find((t) => t.id === taskId);
  const taskSessions = data?.sessions.filter((s) => s.taskId === task?.id) ?? [];
  const session =
    data?.sessions.find((s) => s.id === sessionId && s.taskId === task?.id) ?? taskSessions.at(-1);
  const run = data?.runs.filter((r) => r.sessionId === session?.id).at(-1);
  const active = (r: Run) => ['queued', 'starting', 'running', 'orphaned'].includes(r.state);
  const notify = (text: string, error = false) => {
    setToast({ text, error });
  };
  async function action<T>(fn: () => Promise<T>, message?: string): Promise<T> {
    try {
      const result = await fn();
      await refresh();
      if (message) notify(message);
      return result;
    } catch (e) {
      notify((e as Error).message, true);
      throw e;
    }
  }
  const safe = (fn: () => Promise<unknown>, message?: string) =>
    void action(fn, message).catch(() => {});
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setModal(null);
        setContext(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[aria-label="Search workspace"]')?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (project) setModal({ kind: 'task' });
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [project]);
  useEffect(() => {
    if (tab !== 'diff' || !session) return;
    let cancelled = false;
    setDiffLoading(true);
    api<{ diff: string }>(`/sessions/${session.id}/diff`)
      .then((d) => {
        if (!cancelled) setDiff(d.diff);
      })
      .catch((e) => {
        if (!cancelled) setDiff(e.message);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, tab, run?.state]);
  function selectTask(t: Task) {
    navigate({ projectId: t.projectId, taskId: t.id, sessionId: '', tab: 'console' });
    setInspector(true);
  }
  function selectSession(s: Session) {
    navigate({
      projectId: s.projectId,
      taskId: s.taskId,
      sessionId: s.id,
      view: 'sessions',
      search: '',
    });
    setInspector(true);
  }
  function confirm(title: string, detail: string, label: string, fn: () => Promise<unknown>) {
    setModal({ kind: 'confirm', title, detail, label, action: fn });
  }
  async function submitModal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      if (modal.kind === 'project') {
        const p = await action(
          () =>
            api<Project>('/projects', 'POST', {
              name: f.get('name'),
              repoPath: f.get('repoPath'),
              concurrency: Number(f.get('concurrency')),
            }),
          'Project imported',
        );
        navigate({ projectId: p!.id, taskId: '', sessionId: '', view: 'project', search: '' });
      }
      if (modal.kind === 'task' && project) {
        const body = {
          title: f.get('title'),
          description: f.get('description'),
          criteria: f.get('criteria'),
          provider: f.get('provider'),
          nodeId: f.get('nodeId'),
          parentId: f.get('parentId') || null,
          dependencies: f.getAll('dependencies'),
          priority: Number(f.get('priority')),
          integration: f.get('integration') === 'on',
          remoteRepoPath: f.get('remoteRepoPath'),
          experiment: readExperiment(f),
          validationCommand: JSON.parse(String(f.get('validationCommand') || '[]')),
          allocation: {
            cpu: Number(f.get('cpu')),
            ramMb: Number(f.get('ramMb')),
            gpu: f.get('gpu') || null,
            vramMb: Number(f.get('vramMb')),
            timeoutSec: Number(f.get('timeoutSec')),
          },
        };
        const t = await action(
          () =>
            api<Task>(
              modal.task ? `/tasks/${modal.task.id}` : `/projects/${project.id}/tasks`,
              modal.task ? 'PATCH' : 'POST',
              body,
            ),
          'Task saved',
        );
        navigate({
          view: 'project',
          projectId: t!.projectId,
          taskId: t!.id,
          sessionId: '',
          tab: 'console',
          search: '',
        });
      }
      if (modal.kind === 'launch') {
        const r = await action(
          () =>
            api<Run>(`/tasks/${modal.task.id}/runs`, 'POST', {
              requestKey: crypto.randomUUID(),
              prompt: f.get('prompt'),
              model: f.get('model') || undefined,
              sessionId: modal.sessionId,
              allowReal: f.get('allowReal') === 'on',
              allowValidation: f.get('allowValidation') === 'on',
            }),
          'Run queued',
        );
        navigate({
          sessionId: r!.sessionId,
          view: 'sessions',
          taskId: modal.task.id,
          projectId: modal.task.projectId,
          tab: 'console',
          search: '',
        });
      }
      if (modal.kind === 'node')
        await action(
          () =>
            api('/nodes', 'POST', {
              name: f.get('name'),
              sshAlias: f.get('sshAlias'),
              workerPath: f.get('workerPath'),
              cpu: Number(f.get('cpu')),
              ramMb: Number(f.get('ramMb')),
            }),
          'SSH node added. Probe it before execution.',
        );
      if (modal.kind === 'confirm') await action(modal.action, 'Action completed');
      setModal(null);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  if (isLoading)
    return (
      <div className="boot">
        <div className="brand-mark">
          <Layers />
        </div>
        <h2>AI Agent Workspace</h2>
        <p>Connecting to your local control plane…</p>
      </div>
    );
  if (error || !data)
    return (
      <div className="boot">
        <AlertCircle />
        <h2>Local server unavailable</h2>
        <p>{error?.message}</p>
        <button className="primary" onClick={() => void refresh()}>
          Retry connection
        </button>
      </div>
    );
  const running = data.runs.filter((r) => ['starting', 'running'].includes(r.state)),
    queued = data.runs.filter((r) => r.state === 'queued'),
    pending = data.approvals.filter((a) => a.state === 'pending'),
    metric = data.metrics.local;
  const workspace = data.workspaces.find((w) => w.id === session?.workspaceId);
  const filteredEvents = events.filter(
    (e) =>
      (view !== 'sessions' || e.sessionId === session?.id) &&
      (!search ||
        JSON.stringify(e.data).toLowerCase().includes(search.toLowerCase()) ||
        e.type.toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <div className="app" onClick={() => context && setContext(null)}>
      <AppShell
        view={view}
        setView={setView}
        projects={data.projects}
        project={project}
        tasks={tasks}
        taskId={taskId}
        runningCount={running.length}
        queuedCount={queued.length}
        connected={connected}
        onImport={() => setModal({ kind: 'project' })}
        onProject={(id) =>
          navigate({ view: 'project', projectId: id, taskId: '', sessionId: '', search: '' })
        }
        selectTask={selectTask}
        search={search}
        setSearch={setSearch}
        inspector={inspector}
        setInspector={setInspector}
        width={width}
        setWidth={setWidth}
        metric={metric}
        inspectorContent={
          <>
            <div className="inspector-heading">
              <span>{task ? 'TASK INSPECTOR' : 'WORKSPACE INSPECTOR'}</span>
              <button aria-label="Close inspector" onClick={() => setInspector(false)}>
                <X size={15} />
              </button>
            </div>
            {task ? (
              <>
                <div className="inspector-title">
                  <span className="subtle">TASK · {short(task.id)}</span>
                  <h2>{task.title}</h2>
                  <Badge state={task.state} />
                </div>
                <div className="inspector-section">
                  <h3>Execution</h3>
                  <dl>
                    <dt>Provider</dt>
                    <dd>{task.provider}</dd>
                    <dt>Node</dt>
                    <dd>{data.nodes.find((n) => n.id === task.nodeId)?.name}</dd>
                    <dt>Priority</dt>
                    <dd>{task.priority} / 100</dd>
                    <dt>Dependencies</dt>
                    <dd>
                      {task.dependencies.length
                        ? task.dependencies
                            .map((id) => tasks.find((t) => t.id === id)?.title)
                            .join(', ')
                        : 'None'}
                    </dd>
                  </dl>
                  <button
                    className="secondary full"
                    onClick={() => setModal({ kind: 'task', task })}
                  >
                    Configure task
                  </button>
                </div>
                <div className="inspector-section">
                  <h3>
                    Resource allocation <span>SOFT</span>
                  </h3>
                  <div className="allocation-grid">
                    <div>
                      <Cpu size={15} />
                      <strong>{task.allocation.cpu}</strong>
                      <small>CPU cores</small>
                    </div>
                    <div>
                      <MemoryStick size={15} />
                      <strong>{task.allocation.ramMb}</strong>
                      <small>RAM · MB</small>
                    </div>
                  </div>
                  <dl>
                    <dt>GPU device</dt>
                    <dd>{task.allocation.gpu ?? 'None selected'}</dd>
                    <dt>VRAM budget</dt>
                    <dd>{task.allocation.vramMb} MB · soft</dd>
                    <dt>Timeout</dt>
                    <dd>{task.allocation.timeoutSec}s · enforced</dd>
                  </dl>
                </div>
                {task.error && (
                  <div className="inspector-section">
                    <div className="error-card">
                      <AlertCircle size={16} />
                      <p>{task.error}</p>
                    </div>
                  </div>
                )}
                {run?.state === 'orphaned' && (
                  <div className="inspector-section">
                    <button
                      className="warning full"
                      onClick={() =>
                        confirm(
                          'Reconcile uncertain execution',
                          'Inspect the execution node first. Confirm that this run and all child processes have stopped. This releases quarantined capacity; it does not claim the run succeeded.',
                          'Confirm process stopped',
                          () =>
                            api(`/runs/${run.id}/reconcile`, 'POST', {
                              confirmedStopped: true,
                            }),
                        )
                      }
                    >
                      Reconcile execution
                    </button>
                  </div>
                )}
                {session && (
                  <div className="inspector-section">
                    <h3>Git workspace</h3>
                    <dl>
                      <dt>Session</dt>
                      <dd>{short(session.id)}</dd>
                      <dt>Branch</dt>
                      <dd className="break">{workspace?.branch ?? 'Pending'}</dd>
                      <dt>Base</dt>
                      <dd>{short(workspace?.baseCommit)}</dd>
                      <dt>Snapshot</dt>
                      <dd>{short(workspace?.headCommit)}</dd>
                    </dl>
                    <div className="button-stack">
                      <button
                        className="secondary full"
                        onClick={() => {
                          navigate({ view: 'sessions', tab: 'diff', search: '' });
                        }}
                      >
                        <FileCode size={14} />
                        Review changes
                      </button>
                      {workspace && !workspace.cleaned && (
                        <button
                          className="text-button"
                          onClick={() =>
                            confirm(
                              'Clean up worktree',
                              'Remove only this managed, clean worktree. The branch and all recorded history will be retained. Uncommitted changes block cleanup.',
                              'Clean up worktree',
                              () =>
                                api(`/sessions/${session.id}/cleanup`, 'POST', {
                                  confirmed: true,
                                }),
                            )
                          }
                        >
                          Clean up worktree
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="inspector-title">
                  <div className="inspector-art">
                    <Network size={36} />
                  </div>
                  <h2>Built for parallel work</h2>
                  <p>
                    Select a task or session to inspect its configuration, worktree, and execution.
                  </p>
                </div>
                <div className="inspector-section">
                  <h3>Execution policy</h3>
                  <div className="policy-item">
                    <Check size={15} />
                    <span>Isolated Git worktrees</span>
                  </div>
                  <div className="policy-item">
                    <Check size={15} />
                    <span>Persistent event history</span>
                  </div>
                  <div className="policy-item">
                    <Check size={15} />
                    <span>Explicit merge approval</span>
                  </div>
                  <div className="policy-item">
                    <Shield size={15} />
                    <span>Loopback API + local authentication</span>
                  </div>
                </div>
              </>
            )}
            <div className="inspector-section">
              <h3>
                Pending approvals <span>{pending.length}</span>
              </h3>
              {pending.map((a) => (
                <div className="approval-card" key={a.id}>
                  <GitMerge size={17} />
                  <b>Merge reviewed changes</b>
                  <small>
                    {data.projects.find((p) => p.id === a.projectId)?.name} ·{' '}
                    {
                      data.tasks.find(
                        (t) => t.id === data.sessions.find((s) => s.id === a.sessionId)?.taskId,
                      )?.title
                    }
                  </small>
                  <small>
                    {short(a.source)} → {a.targetBranch} @ {short(a.target)}
                  </small>
                  <p>Inspect the session diff. Approval applies only to these exact commits.</p>
                  <div className="button-group">
                    <button
                      className="primary small"
                      onClick={() =>
                        confirm(
                          'Approve merge',
                          `Integrate source ${a.source} into ${a.targetBranch} at ${a.target}? The server rejects stale approvals and dirty targets.`,
                          'Approve and merge',
                          () => api(`/approvals/${a.id}`, 'POST', { approved: true }),
                        )
                      }
                    >
                      Review approval
                    </button>
                    <button
                      className="secondary small"
                      onClick={() =>
                        safe(
                          () => api(`/approvals/${a.id}`, 'POST', { approved: false }),
                          'Approval rejected',
                        )
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
              {!pending.length && <p className="subtle">Nothing awaiting your review.</p>}
            </div>
            {data.approvals
              .filter((a) => a.state === 'applying')
              .map((a) => (
                <div className="approval-card" key={a.id}>
                  <b>Check merge outcome</b>
                  <small>
                    {a.targetBranch} · {short(a.previewCommit)}
                  </small>
                  <p>{a.error ?? 'Checking the target branch against the approved commit.'}</p>
                  <button
                    className="secondary small"
                    onClick={() =>
                      safe(
                        () => api(`/approvals/${a.id}/reconcile`, 'POST', {}),
                        'Merge status checked',
                      )
                    }
                  >
                    Check target branch
                  </button>
                </div>
              ))}
            <div className="inspector-footer">
              <Shield size={14} />
              Local by default. Explicit by design.
            </div>
          </>
        }
      >
        {view === 'focus' && (
          <Focus
            data={data}
            search={search}
            refresh={refresh}
            notify={notify}
            open={(item) => {
              const selected = data.tasks.find((t) => t.id === item.taskId);
              if (!selected) return;
              const selectedSession = data.sessions.find(
                (s) => s.id === item.sessionId && s.taskId === selected.id,
              );
              const configuration = item.kind === 'clarify' || item.kind === 'ready';
              navigate({
                projectId: selected.projectId,
                taskId: selected.id,
                sessionId: configuration ? '' : (selectedSession?.id ?? ''),
                view: !configuration && selectedSession ? 'sessions' : 'project',
                tab: ['review', 'approve', 'stale'].includes(item.kind) ? 'diff' : 'history',
                search: '',
              });
              setInspector(true);
              if (item.kind === 'clarify') setModal({ kind: 'task', task: selected });
              if (item.kind === 'ready') setModal({ kind: 'launch', task: selected });
            }}
          />
        )}
        {view === 'dashboard' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span /> YOUR DEVELOPMENT CONTROL PLANE
                </div>
                <h1>Workspace overview</h1>
                <p>A clear view of your agents, projects, and execution.</p>
              </div>
              <button className="primary" onClick={() => setModal({ kind: 'project' })}>
                <Plus size={15} />
                Import project
              </button>
            </div>
            <div className="stat-grid">
              {[
                {
                  label: 'Active projects',
                  value: data.projects.filter((p) => !p.archived).length,
                  icon: FolderGit2,
                  sub: 'Connected Git repositories',
                  color: 'blue',
                },
                {
                  label: 'Running sessions',
                  value: running.length,
                  icon: MessagesSquare,
                  sub: `${data.sessions.length} sessions in history`,
                  color: 'green',
                },
                {
                  label: 'Queued tasks',
                  value: queued.length,
                  icon: Layers,
                  sub: 'Waiting for dependencies or capacity',
                  color: 'purple',
                },
                {
                  label: 'Awaiting approval',
                  value: pending.length,
                  icon: Shield,
                  sub: 'Reviewed commits, explicit consent',
                  color: 'amber',
                },
              ].map((s) => (
                <div className="stat-card" key={s.label}>
                  <div>
                    <span>{s.label}</span>
                    <s.icon size={17} className={s.color} />
                  </div>
                  <strong>{String(s.value).padStart(2, '0')}</strong>
                  <small>{s.sub}</small>
                </div>
              ))}
            </div>
            <div className="dashboard-grid">
              <section className="surface projects-panel">
                <div className="section-heading">
                  <h2>
                    Projects <span>{data.projects.filter((p) => !p.archived).length}</span>
                  </h2>
                  <button className="text-button" onClick={() => setView('project')}>
                    View all <ArrowUpRight size={13} />
                  </button>
                </div>
                {data.projects
                  .filter((p) => !p.archived)
                  .map((p) => {
                    const ts = data.tasks.filter((t) => t.projectId === p.id);
                    const done = ts.filter((t) => t.state === 'completed').length;
                    return (
                      <button
                        className="project-card"
                        key={p.id}
                        onClick={() => {
                          navigate({
                            view: 'project',
                            projectId: p.id,
                            taskId: '',
                            sessionId: '',
                            search: '',
                          });
                        }}
                      >
                        <div className="project-card-icon">
                          <FolderGit2 size={23} />
                        </div>
                        <div className="project-card-main">
                          <h3>
                            {p.name}
                            <ChevronRight size={15} />
                          </h3>
                          <p>
                            <GitBranch size={12} />
                            {p.baseBranch}
                            <span>·</span>
                            {ts.length} tasks
                          </p>
                          <div className="project-progress">
                            <i style={{ width: `${ts.length ? (done / ts.length) * 100 : 0}%` }} />
                          </div>
                          <small>
                            {done} of {ts.length} executions completed · integration reviewed
                            separately
                          </small>
                        </div>
                      </button>
                    );
                  })}
                {!data.projects.length && (
                  <Empty title="Bring your repository">
                    <span>
                      Import a local Git repository with an initial commit.
                      <br />
                      <button className="text-button" onClick={() => setModal({ kind: 'project' })}>
                        Import project <ArrowRight size={14} />
                      </button>
                    </span>
                  </Empty>
                )}
              </section>
              <section className="surface">
                <div className="section-heading">
                  <h2>Local compute</h2>
                  <Badge state="online" />
                </div>
                <div className="compute-summary">
                  <div className="node-title">
                    <div className="node-icon">
                      <Monitor size={23} />
                    </div>
                    <div>
                      <h3>{data.nodes.find((n) => n.id === 'local')?.name}</h3>
                      <small>Local execution node · real telemetry</small>
                    </div>
                  </div>
                  <MetricBar
                    label="CPU utilization"
                    value={metric?.cpuPercent ?? null}
                    detail={`${metric?.cores ?? '—'} logical cores · ${data.reservations.filter((r) => r.nodeId === 'local').reduce((s, r) => s + r.cpu, 0)} reserved`}
                  />
                  <MetricBar
                    label="Memory"
                    value={metric ? (metric.ramUsedMb / metric.ramTotalMb) * 100 : null}
                    detail={
                      metric
                        ? `${(metric.ramUsedMb / 1024).toFixed(1)} / ${(metric.ramTotalMb / 1024).toFixed(1)} GB`
                        : 'Waiting for first sample'
                    }
                  />
                  <div className="gpu-summary">
                    <Cpu size={15} />
                    <span>NVIDIA GPU</span>
                    <b>{metric?.gpus?.length ? metric.gpus[0].name : 'Unavailable'}</b>
                  </div>
                  <button className="text-button" onClick={() => setView('compute')}>
                    Manage compute nodes <ArrowUpRight size={13} />
                  </button>
                </div>
              </section>
            </div>
            <div className="dashboard-grid lower">
              <section className="surface">
                <div className="section-heading">
                  <h2>Recent activity</h2>
                  <button className="text-button" onClick={() => setView('activity')}>
                    Full timeline <ArrowUpRight size={13} />
                  </button>
                </div>
                <Timeline events={events.slice(-6).reverse()} />
              </section>
              <section className="surface">
                <div className="section-heading">
                  <h2>Agent providers</h2>
                  <span className="subtle">Native authentication</span>
                </div>
                <div className="provider-list">
                  {data.providers.map((p) => (
                    <div className="provider-card" key={p.id}>
                      <span className={`provider-avatar ${p.id}`}>
                        {p.id === 'codex' ? 'O' : p.id === 'claude' ? '✳' : 'M'}
                      </span>
                      <div>
                        <b>{p.name}</b>
                        <small>
                          {p.id === 'mock'
                            ? 'Test fixture · no inference'
                            : (p.version ?? 'Not installed')}
                        </small>
                      </div>
                      <Badge
                        state={
                          p.id === 'mock'
                            ? 'test'
                            : p.authenticated
                              ? 'ready'
                              : p.installed
                                ? 'setup'
                                : 'unavailable'
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="note">
                  <Shield size={14} />
                  <span>
                    Credentials stay with the native CLI. Real agents run only after your explicit
                    launch.
                  </span>
                </div>
              </section>
            </div>
          </>
        )}
        {view === 'project' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">PROJECT WORKSPACE</div>
                <h1>{project?.name ?? 'Projects'}</h1>
                <p>
                  <GitBranch size={13} />
                  {project?.baseBranch ?? 'No repository selected'}
                  <span className="divider">/</span>
                  {project?.repoPath ?? 'Import a local repository to get started'}
                </p>
              </div>
              <div className="button-group">
                {project && (
                  <button
                    className="secondary"
                    onClick={() =>
                      confirm(
                        'Archive project',
                        `Archive ${project.name}? Source files and execution history are preserved.`,
                        'Archive project',
                        () => api(`/projects/${project.id}`, 'PATCH', { archived: true }),
                      )
                    }
                  >
                    Archive
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!project}
                  onClick={() => setModal({ kind: 'task' })}
                >
                  <Plus size={15} />
                  New task
                </button>
              </div>
            </div>
            <div className="project-ribbon">
              <span>
                <span className="dot green-bg" />
                {tasks.filter((t) => t.state === 'running').length} running
              </span>
              <span>
                <Check size={13} />
                {tasks.filter((t) => t.state === 'completed').length} completed
              </span>
              <span>
                <Layers size={13} />
                {project?.concurrency ?? 0} parallel slots
              </span>
              <span>
                <GitMerge size={13} />
                Explicit integration approval
              </span>
            </div>
            <section className="surface task-surface">
              <div className="task-toolbar">
                <div className="segmented">
                  <button
                    className={treeMode === 'tree' ? 'active' : ''}
                    onClick={() => setTreeMode('tree')}
                  >
                    <ListTree size={15} />
                    Task tree
                  </button>
                  <button
                    className={treeMode === 'graph' ? 'active' : ''}
                    onClick={() => setTreeMode('graph')}
                  >
                    <Network size={15} />
                    Dependencies
                  </button>
                </div>
                <small>{tasks.length} tasks · drag to reparent</small>
                <button
                  className="secondary small"
                  disabled={!tasks.some((t) => t.state === 'draft')}
                  onClick={() =>
                    confirm(
                      'Queue draft tasks',
                      `Queue ${tasks.filter((t) => t.state === 'draft').length} tasks? Dependencies and resource budgets determine start order. This authorizes provider usage and the configured validation commands: ${
                        tasks
                          .filter((t) => t.state === 'draft' && t.validationCommand?.length)
                          .map((t) => JSON.stringify(t.validationCommand))
                          .join(', ') || 'none'
                      }.`,
                      'Queue tasks',
                      async () => {
                        for (const t of tasks.filter((t) => t.state === 'draft'))
                          await api(`/tasks/${t.id}/runs`, 'POST', {
                            requestKey: crypto.randomUUID(),
                            allowReal: true,
                            allowValidation: true,
                          });
                      },
                    )
                  }
                >
                  <Play size={13} />
                  Queue draft tasks
                </button>
              </div>
              {!tasks.length ? (
                <Empty title="Plan the work, then let your agents execute">
                  Create tasks, assign a provider, and connect dependencies.
                  <br />
                  <button
                    className="text-button"
                    disabled={!project}
                    onClick={() => setModal({ kind: 'task' })}
                  >
                    Create your first task <ArrowRight size={14} />
                  </button>
                </Empty>
              ) : treeMode === 'tree' ? (
                <>
                  <div className="task-table-head">
                    <span>TASK</span>
                    <span>STATUS</span>
                    <span>AGENT</span>
                    <span>NODE</span>
                    <span />
                  </div>
                  <div role="tree" aria-label="Project task tree">
                    <TaskTree
                      tasks={tasks}
                      taskId={taskId}
                      search={search}
                      nodes={data.nodes}
                      activeTaskIds={new Set(data.runs.filter(active).map((r) => r.taskId))}
                      selectTask={selectTask}
                      onMenu={setContext}
                      onLaunch={(task) => setModal({ kind: 'launch', task })}
                      onMove={(id, parentId) =>
                        safe(() => api(`/tasks/${id}`, 'PATCH', { parentId }), 'Task moved')
                      }
                    />
                  </div>
                  <button
                    className="add-task-row"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/task');
                      if (id)
                        safe(
                          () => api(`/tasks/${id}`, 'PATCH', { parentId: null }),
                          'Moved to root',
                        );
                    }}
                    onClick={() => setModal({ kind: 'task' })}
                  >
                    <Plus size={14} /> Add a task <span>or drop here to move to root</span>
                  </button>
                </>
              ) : (
                <Suspense fallback={<p role="status">Loading graph…</p>}>
                  <DependencyGraph tasks={tasks} select={selectTask} />
                </Suspense>
              )}
            </section>
            <div className="project-footnote">
              <Shield size={14} />
              Tree hierarchy organizes work. Dependency edges control execution. Completion does not
              automatically merge code.
            </div>
            {task && (
              <section className="surface task-detail">
                <div className="section-heading">
                  <h2>{task.title}</h2>
                  <button className="text-button" onClick={() => setModal({ kind: 'task', task })}>
                    Edit task <ArrowUpRight size={13} />
                  </button>
                </div>
                <p>{task.description || 'No description added.'}</p>
                {task.criteria && (
                  <div className="criteria">
                    <small>ACCEPTANCE CRITERIA</small>
                    <p>{task.criteria}</p>
                  </div>
                )}
                <div className="session-chips">
                  {taskSessions.map((s) => (
                    <button key={s.id} className="secondary small" onClick={() => selectSession(s)}>
                      <MessagesSquare size={13} />
                      {short(s.id)}
                      <ArrowRight size={13} />
                    </button>
                  ))}
                  {!taskSessions.length && (
                    <small>No sessions yet. Start a run to create an isolated worktree.</small>
                  )}
                </div>
              </section>
            )}
          </>
        )}
        {view === 'sessions' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">MULTI-AGENT EXECUTION</div>
                <h1>Session console</h1>
                <p>Conversation, execution, and source changes in one place.</p>
              </div>
              {task && (
                <button
                  className="primary"
                  disabled={Boolean(run && active(run))}
                  onClick={() => setModal({ kind: 'launch', task, sessionId: session?.id })}
                >
                  <Play size={14} />
                  {session ? 'Continue session' : 'Start session'}
                </button>
              )}
            </div>
            <div className="session-picker">
              {data.sessions
                .filter(
                  (s) =>
                    !search ||
                    data.tasks
                      .find((t) => t.id === s.taskId)
                      ?.title.toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .map((s) => {
                  const r = data.runs.filter((r) => r.sessionId === s.id).at(-1);
                  return (
                    <button
                      key={s.id}
                      className={session?.id === s.id ? 'active' : ''}
                      onClick={() => {
                        selectSession(s);
                      }}
                    >
                      <span className={`task-dot ${r?.state}`} />
                      <span>
                        {data.tasks.find((t) => t.id === s.taskId)?.title}
                        <small>
                          {s.provider} · {short(s.id)}
                        </small>
                      </span>
                    </button>
                  );
                })}
            </div>
            {!session ? (
              <Empty icon={<MessagesSquare />} title="No session selected">
                Start a task from a project to create its first isolated execution.
              </Empty>
            ) : (
              <section className="surface console-surface">
                <div className="console-header">
                  <div>
                    <span className={`provider-avatar small ${session.provider}`}>
                      {session.provider === 'codex'
                        ? 'O'
                        : session.provider === 'claude'
                          ? '✳'
                          : 'M'}
                    </span>
                    <b>{task?.title}</b>
                    <Badge state={run?.state ?? 'draft'} />
                  </div>
                  <div className="button-group">
                    {run && ['starting', 'running', 'queued'].includes(run.state) && (
                      <>
                        <button
                          className="secondary small"
                          onClick={() =>
                            safe(
                              () => api(`/runs/${run.id}/cancel`, 'POST', { mode: 'paused' }),
                              'Interrupt requested',
                            )
                          }
                        >
                          <Pause size={13} />
                          Interrupt
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Cancel run"
                          onClick={() =>
                            confirm(
                              'Cancel execution',
                              'Stop this execution? The worktree and history will be retained.',
                              'Cancel run',
                              () => api(`/runs/${run.id}/cancel`, 'POST', { mode: 'cancelled' }),
                            )
                          }
                        >
                          <Square size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {run && (
                  <ResultEvidence
                    data={data}
                    run={run}
                    restart={() => task && setModal({ kind: 'launch', task })}
                  />
                )}
                <div className="tabs">
                  {[
                    ['console', 'Conversation', MessagesSquare],
                    ['terminal', 'Tool output', TerminalSquare],
                    ['diff', 'Git diff', FileCode],
                    ['history', 'Run history', History],
                    ['artifacts', 'Artifacts', Box],
                  ].map(([id, label, Icon]) => {
                    const I = Icon as typeof FileCode;
                    return (
                      <button
                        key={id as string}
                        className={tab === id ? 'active' : ''}
                        onClick={() => setTab(id as string)}
                      >
                        <I size={14} />
                        {label as string}
                      </button>
                    );
                  })}
                </div>
                {tab === 'console' && (
                  <div className="messages">
                    {filteredEvents
                      .filter((e) =>
                        [
                          'MessageReceived',
                          'MessageDelta',
                          'ToolStarted',
                          'ToolCompleted',
                          'SessionFailed',
                          'ApprovalRequested',
                          'SessionCompleted',
                          'RunOrphaned',
                        ].includes(e.type),
                      )
                      .map((e) => (
                        <div key={e.id} className={`message ${e.type}`}>
                          <div className="message-meta">
                            <span>
                              {e.type === 'MessageReceived'
                                ? 'YOU'
                                : e.type === 'MessageDelta'
                                  ? session.provider.toUpperCase()
                                  : e.type.replace(/([A-Z])/g, ' $1').trim()}
                            </span>
                            <time>{fmt(e.createdAt)}</time>
                          </div>
                          <div className="message-content">
                            {String(
                              e.data.text ??
                                e.data.name ??
                                e.data.error ??
                                e.data.detail ??
                                (e.type === 'SessionCompleted'
                                  ? 'Execution completed. Review the diff before integration.'
                                  : JSON.stringify(e.data)),
                            )}
                          </div>
                          {e.type === 'ToolCompleted' && e.data.output !== undefined && (
                            <pre>
                              {typeof e.data.output === 'string'
                                ? e.data.output
                                : JSON.stringify(e.data.output, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    {!filteredEvents.length && (
                      <Empty title="Waiting for execution events">
                        The scheduler will launch this session when dependencies and capacity are
                        ready.
                      </Empty>
                    )}
                  </div>
                )}
                {tab === 'terminal' && (
                  <Suspense fallback={<p role="status">Loading tool output…</p>}>
                    <TerminalOutput
                      key={session.id}
                      events={events.filter((e) => e.sessionId === session.id)}
                    />
                  </Suspense>
                )}
                {tab === 'diff' && (
                  <div className="diff-view">
                    <div className="diff-toolbar">
                      <span>
                        <GitBranch size={14} />
                        {workspace?.branch ?? 'Worktree pending'}
                      </span>
                      <button
                        className="secondary small"
                        disabled={
                          !workspace ||
                          workspace.nodeId !== 'local' ||
                          workspace.cleaned ||
                          run?.state !== 'completed'
                        }
                        onClick={() =>
                          safe(
                            () =>
                              api<Approval>(`/sessions/${session.id}/merge-preview`, 'POST', {}),
                            'Merge preview created. Review the approval in the inspector.',
                          )
                        }
                      >
                        <GitMerge size={13} />
                        Preview merge
                      </button>
                    </div>
                    {diffLoading ? (
                      <p className="padding">Loading diff…</p>
                    ) : (
                      <pre>
                        {diff
                          ? diff.split('\n').map((line, i) => (
                              <div
                                className={
                                  line.startsWith('+')
                                    ? 'diff-add'
                                    : line.startsWith('-')
                                      ? 'diff-remove'
                                      : line.startsWith('@@')
                                        ? 'diff-hunk'
                                        : ''
                                }
                                key={i}
                              >
                                {line || ' '}
                              </div>
                            ))
                          : 'No recorded changes.'}
                      </pre>
                    )}
                  </div>
                )}
                {tab === 'history' && (
                  <div className="run-history">
                    {data.runs
                      .filter((r) => r.sessionId === session.id)
                      .reverse()
                      .map((r) => (
                        <div className="run-row" key={r.id}>
                          <History size={16} />
                          <div>
                            <b>{short(r.id)}</b>
                            <small>
                              {new Date(r.createdAt).toLocaleString()} ·{' '}
                              {r.endedAt && r.startedAt
                                ? `${((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)}s`
                                : 'Pending / active'}
                            </small>
                            {r.error && <p className="error-text">{r.error}</p>}
                          </div>
                          <Badge state={r.state} />
                        </div>
                      ))}
                  </div>
                )}
                {tab === 'artifacts' && (
                  <div className="artifact-list">
                    {data.artifacts
                      .filter((a) =>
                        data.runs.some((r) => r.id === a.runId && r.sessionId === session.id),
                      )
                      .map((a) => (
                        <details key={a.id}>
                          <summary>
                            <FileCode size={15} />
                            {a.name}
                            <span>{short(a.runId)}</span>
                          </summary>
                          <pre>{a.content}</pre>
                          <button
                            className="secondary small"
                            onClick={() => {
                              const url = URL.createObjectURL(
                                new Blob([a.content], { type: 'text/plain' }),
                              );
                              const link = document.createElement('a');
                              link.href = url;
                              link.download = a.name;
                              link.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }}
                          >
                            <ArrowDownToLine size={13} />
                            Download artifact
                          </button>
                        </details>
                      ))}
                  </div>
                )}
                <div className="console-bottom">
                  <span>
                    <GitBranch size={12} />
                    {workspace?.branch ?? 'Worktree created when run starts'}
                  </span>
                  <span>
                    <Zap size={12} />
                    {run?.usage?.input_tokens !== undefined
                      ? `${run.usage.input_tokens} in · ${run.usage.output_tokens ?? '—'} out tokens`
                      : 'Token usage unavailable'}
                  </span>
                </div>
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (task) setModal({ kind: 'launch', task, sessionId: session.id });
                  }}
                >
                  <MessagesSquare size={17} />
                  <span>
                    {run && active(run)
                      ? 'Execution active. Interrupt before sending another turn.'
                      : 'Continue the conversation with a new instruction.'}
                  </span>
                  <button
                    className="secondary small"
                    disabled={session.closed || Boolean(run && active(run))}
                    type="submit"
                  >
                    New instruction <ArrowRight size={13} />
                  </button>
                </form>
              </section>
            )}
          </>
        )}
        {view === 'experiments' && (
          <Suspense fallback={<p>Loading experiments…</p>}>
            <ExperimentsPage
              data={data}
              search={search}
              onRun={(r) => {
                const s = data.sessions.find((s) => s.id === r.sessionId);
                if (s) selectSession(s);
              }}
              onCreate={(selectedProjectId) => {
                const target =
                  data.projects.find((p) => p.id === selectedProjectId && !p.archived) ??
                  (selectedProjectId
                    ? undefined
                    : data.projects.find((p) => p.id === project?.id && !p.archived));
                if (target) {
                  navigate({ projectId: target.id, taskId: '', sessionId: '' }, true);
                  setModal({ kind: 'task', experiment: true });
                } else if (selectedProjectId)
                  notify('Choose an active project before creating a task.', true);
                else setModal({ kind: 'project' });
              }}
            />
          </Suspense>
        )}
        {view === 'compute' && (
          <Suspense fallback={<p role="status">Loading compute workspace…</p>}>
            <Compute
              data={data}
              onAdd={() => setModal({ kind: 'node' })}
              onRefresh={(id) => {
                void safe(() => api(`/nodes/${id}/probe`, 'POST', {}), 'Node telemetry refreshed');
              }}
              onTask={(t) => {
                navigate({
                  view: 'project',
                  projectId: t.projectId,
                  taskId: t.id,
                  sessionId: '',
                  search: '',
                });
                setInspector(true);
              }}
            />
          </Suspense>
        )}
        {view === 'activity' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">PERSISTENT EVENT STORE</div>
                <h1>Activity timeline</h1>
                <p>Execution history, replayed from SQLite. Latest 5,000 events in this view.</p>
              </div>
              <span className="event-counter">{events.length} loaded events</span>
            </div>
            <section className="surface">
              <Timeline events={filteredEvents.slice().reverse()} full />
            </section>
          </>
        )}
        {view === 'settings' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">WORKSPACE CONFIGURATION</div>
                <h1>Settings & providers</h1>
                <p>Your local tools. Your accounts. Explicit capabilities.</p>
              </div>
              <button
                className="secondary"
                onClick={() =>
                  safe(() => api('/providers/refresh', 'POST', {}), 'Provider checks refreshed')
                }
              >
                <RefreshCw size={14} />
                Check providers
              </button>
            </div>
            <div className="settings-grid">
              {data.providers.map((p) => (
                <section className="surface provider-settings" key={p.id}>
                  <div className="section-heading">
                    <h2>{p.name}</h2>
                    <Badge
                      state={
                        p.authenticated
                          ? 'ready'
                          : p.id === 'mock'
                            ? 'test'
                            : p.installed
                              ? 'setup'
                              : 'unavailable'
                      }
                    />
                  </div>
                  <p>{p.detail}</p>
                  <code>{p.version ?? 'Version unavailable'}</code>
                  <dl>
                    <dt>Streaming / resume</dt>
                    <dd>
                      {p.capabilities.streaming ? 'Supported' : 'Unavailable'} /{' '}
                      {p.capabilities.resume ? 'Supported' : 'Unavailable'}
                    </dd>
                    <dt>Interactive tool approval</dt>
                    <dd>{p.capabilities.interactiveApproval ? 'Supported' : 'Unavailable'}</dd>
                    <dt>CPU / RAM hard limits</dt>
                    <dd>Unavailable</dd>
                    <dt>Cost</dt>
                    <dd>
                      {p.capabilities.cost === 'estimate'
                        ? 'Provider estimate · cumulative conversation'
                        : 'Unavailable'}
                    </dd>
                  </dl>
                  {p.id !== 'mock' && (
                    <div className="setup-code">
                      <small>Run in your own terminal to authenticate:</small>
                      <code>{p.id === 'codex' ? 'npx codex login' : 'npx claude auth login'}</code>
                      <p>The application does not read or copy credential files.</p>
                    </div>
                  )}
                </section>
              ))}
            </div>
            <section className="surface preference-panel">
              <h2>Interface</h2>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={inspector}
                  onChange={(e) => setInspector(e.target.checked)}
                />
                Show contextual inspector
              </label>
              <label className="range-label">
                Inspector width
                <input
                  aria-label="Inspector width"
                  type="range"
                  min="270"
                  max="480"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                />
                <span>{width}px</span>
              </label>
              <p>
                <kbd>Ctrl / ⌘ K</kbd> Search <kbd>Ctrl / ⌘ Shift N</kbd> New task <kbd>Esc</kbd>{' '}
                Dismiss
              </p>
            </section>
            {data.projects.some((p) => p.archived) && (
              <section className="surface preference-panel">
                <h2>Archived projects</h2>
                {data.projects
                  .filter((p) => p.archived)
                  .map((p) => (
                    <div className="run-row" key={p.id}>
                      {p.name}
                      <button
                        className="secondary small"
                        onClick={() =>
                          safe(
                            () => api(`/projects/${p.id}`, 'PATCH', { archived: false }),
                            'Project restored',
                          )
                        }
                      >
                        Restore
                      </button>
                    </div>
                  ))}
              </section>
            )}
          </>
        )}
      </AppShell>
      {context && (
        <div
          className="context-menu"
          style={{ left: context.x, top: context.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {[
            {
              label: 'Edit task',
              icon: Settings,
              run: () => setModal({ kind: 'task', task: context.task }),
            },
            {
              label: 'Add child task',
              icon: Plus,
              run: () => setModal({ kind: 'task', parentId: context.task.id }),
            },
            {
              label: 'Duplicate task',
              icon: Copy,
              run: () =>
                safe(
                  () =>
                    api(`/projects/${context.task.projectId}/tasks`, 'POST', {
                      ...context.task,
                      title: `${context.task.title} (copy)`,
                    }),
                  'Task duplicated',
                ),
            },
            {
              label: 'Delete task',
              icon: Trash2,
              run: () =>
                confirm(
                  'Delete task',
                  `Delete ${context.task.title}? Tasks with execution history or dependents are protected.`,
                  'Delete task',
                  () => api(`/tasks/${context.task.id}`, 'DELETE'),
                ),
            },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                item.run();
                setContext(null);
              }}
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </div>
      )}
      {toast && (
        <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{toast.text}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <ModalFrame
          title={
            modal.kind === 'project'
              ? 'Import Git project'
              : modal.kind === 'task'
                ? modal.task
                  ? 'Edit task'
                  : 'Create task'
                : modal.kind === 'launch'
                  ? modal.sessionId
                    ? 'Continue session'
                    : 'Launch agent session'
                  : modal.kind === 'node'
                    ? 'Connect SSH worker'
                    : modal.title
          }
          close={() => !busy && setModal(null)}
        >
          <form onSubmit={(e) => void submitModal(e)}>
            {modal.kind === 'project' && (
              <>
                <p className="form-hint">
                  Connect an existing local Git repository with at least one commit. Agents work in
                  separate branches and worktrees.
                </p>
                <Field label="Project name" name="name" placeholder="CV-Agent-Project" required />
                <Field
                  label="Repository path"
                  name="repoPath"
                  placeholder="/home/you/projects/cv-agent or C:\\Projects\\cv-agent"
                  required
                />
                <Field
                  label="Concurrent sessions"
                  name="concurrency"
                  type="number"
                  value="2"
                  min="1"
                  max="32"
                />
                <div className="note">
                  <Shield size={15} />
                  The repository is never reset or deleted by this application.
                </div>
              </>
            )}
            {modal.kind === 'task' && (
              <>
                <p className="form-hint">Project · {project?.name}</p>
                <Field
                  label="Task title"
                  name="title"
                  value={modal.task?.title}
                  placeholder="Implement Backend API"
                  required
                />
                <label>
                  Description
                  <textarea
                    name="description"
                    rows={4}
                    defaultValue={modal.task?.description}
                    placeholder="Explain the goal, constraints, and expected changes…"
                  />
                </label>
                <label>
                  Acceptance criteria
                  <textarea
                    name="criteria"
                    rows={2}
                    defaultValue={modal.task?.criteria}
                    placeholder="What must be true when this task is complete?"
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Provider
                    <select name="provider" defaultValue={modal.task?.provider ?? 'mock'}>
                      <option value="mock">Mock Agent · deterministic test</option>
                      <option value="codex">OpenAI Codex</option>
                      <option value="claude">Claude Code</option>
                    </select>
                  </label>
                  <label>
                    Execution node
                    <select name="nodeId" defaultValue={modal.task?.nodeId ?? 'local'}>
                      {data.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name} · {n.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Parent task
                    <select
                      name="parentId"
                      defaultValue={modal.task?.parentId ?? modal.parentId ?? ''}
                    >
                      <option value="">Project root</option>
                      {tasks
                        .filter((t) => t.id !== modal.task?.id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Field
                    label="Priority (0–100)"
                    name="priority"
                    type="number"
                    value={String(modal.task?.priority ?? 50)}
                    min="0"
                    max="100"
                  />
                </div>
                <fieldset>
                  <legend>Execution dependencies</legend>
                  <div className="dependency-choices">
                    {tasks
                      .filter((t) => t.id !== modal.task?.id)
                      .map((t) => (
                        <label className="check-label" key={t.id}>
                          <input
                            name="dependencies"
                            type="checkbox"
                            value={t.id}
                            defaultChecked={modal.task?.dependencies.includes(t.id)}
                          />
                          {t.title}
                        </label>
                      ))}
                    {!tasks.length && <small>No other tasks yet.</small>}
                  </div>
                </fieldset>
                <label className="check-label">
                  <input
                    name="integration"
                    type="checkbox"
                    defaultChecked={modal.task?.integration}
                  />
                  Build an integration worktree from successful dependency commits
                </label>
                <ExperimentFields
                  key={modal.task?.id ?? 'new'}
                  experiment={modal.task?.experiment}
                  initiallyEnabled={modal.experiment}
                />
                <details className="advanced" open={Boolean(modal.task)}>
                  <summary>Resources & remote execution</summary>
                  <div className="form-grid">
                    <Field
                      label="CPU soft budget"
                      name="cpu"
                      type="number"
                      value={String(modal.task?.allocation.cpu ?? 1)}
                      min="0.1"
                      step="0.1"
                    />
                    <Field
                      label="RAM soft budget (MB)"
                      name="ramMb"
                      type="number"
                      value={String(modal.task?.allocation.ramMb ?? 512)}
                      min="1"
                    />
                    <Field
                      label="GPU UUID or index (optional; UUID recommended)"
                      name="gpu"
                      value={modal.task?.allocation.gpu ?? ''}
                      placeholder="GPU-… or 0"
                    />
                    <Field
                      label="VRAM soft budget (MB)"
                      name="vramMb"
                      type="number"
                      value={String(modal.task?.allocation.vramMb ?? 0)}
                      min="0"
                    />
                    <Field
                      label="Execution timeout (seconds)"
                      name="timeoutSec"
                      type="number"
                      value={String(modal.task?.allocation.timeoutSec ?? 600)}
                      min="1"
                      max="86400"
                    />
                  </div>
                  <Field
                    label="Validation command as JSON argv (optional, local only)"
                    name="validationCommand"
                    value={JSON.stringify(modal.task?.validationCommand ?? [])}
                    placeholder={'["node","--test"]'}
                  />
                  <Field
                    label="Remote repository path (SSH tasks only)"
                    name="remoteRepoPath"
                    value={modal.task?.remoteRepoPath ?? ''}
                    placeholder="/srv/projects/cv-agent"
                  />
                </details>
              </>
            )}
            {modal.kind === 'launch' && (
              <>
                <div className="launch-summary">
                  <span className={`provider-avatar ${modal.task.provider}`}>
                    {modal.task.provider === 'mock'
                      ? 'M'
                      : modal.task.provider === 'codex'
                        ? 'O'
                        : '✳'}
                  </span>
                  <div>
                    <b>{modal.task.title}</b>
                    <small>
                      {modal.task.provider} ·{' '}
                      {data.nodes.find((n) => n.id === modal.task.nodeId)?.name} ·{' '}
                      {modal.sessionId ? 'existing conversation' : 'new isolated worktree'}
                    </small>
                  </div>
                </div>
                <label>
                  Instruction
                  <textarea
                    name="prompt"
                    rows={6}
                    required
                    defaultValue={
                      modal.sessionId
                        ? ''
                        : `${modal.task.description}\n\nAcceptance criteria: ${modal.task.criteria}`
                    }
                    placeholder="Describe your next instruction…"
                  />
                </label>
                <Field
                  label="Model (optional — provider default if empty)"
                  name="model"
                  placeholder="Leave empty to use native settings"
                />
                {modal.task.provider !== 'mock' ? (
                  <label className="consent">
                    <input type="checkbox" name="allowReal" required />
                    <span>
                      Run this real provider using my native account. This can consume subscription
                      quota or API credits. The CLI permission policy remains active.
                    </span>
                  </label>
                ) : (
                  <div className="note">
                    <Box size={15} />
                    Mock runs execute deterministic filesystem fixtures. No model inference or token
                    usage.
                  </div>
                )}
                {Boolean(modal.task.validationCommand?.length) && (
                  <label className="consent">
                    <input type="checkbox" name="allowValidation" required />
                    <span>
                      Execute this command in the owned worktree:{' '}
                      <code>{JSON.stringify(modal.task.validationCommand)}</code>. Test code runs
                      with my local user permissions.
                    </span>
                  </label>
                )}
                <p className="form-hint">
                  Queued runs start automatically when dependencies and resources are ready.
                  Interrupt ends the current turn; continuing creates a new run.
                </p>
              </>
            )}
            {modal.kind === 'node' && (
              <>
                <p className="form-hint">
                  Install the worker on a Linux host first. Use an SSH config alias with key
                  authentication and a verified known_hosts entry. The worker requires
                  WORKER_REPO_ROOT.
                </p>
                <Field label="Node name" name="name" placeholder="GPU workstation" required />
                <Field
                  label="SSH config alias"
                  name="sshAlias"
                  placeholder="gpu-workstation"
                  required
                />
                <Field
                  label="Absolute worker entry path (no spaces)"
                  name="workerPath"
                  placeholder="/srv/ai-agent-workspace/dist/worker/src/index.js"
                  required
                />
                <div className="form-grid">
                  <Field label="Schedulable CPU cores" name="cpu" type="number" value="4" min="1" />
                  <Field
                    label="Schedulable RAM (MB)"
                    name="ramMb"
                    type="number"
                    value="8192"
                    min="1"
                  />
                </div>
                <div className="note">
                  <Shield size={15} />
                  Attached SSH transport. A lost connection requires reconciliation before capacity
                  is released.
                </div>
              </>
            )}
            {modal.kind === 'confirm' && <p className="confirm-detail">{modal.detail}</p>}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy
                  ? 'Working…'
                  : modal.kind === 'project'
                    ? 'Import project'
                    : modal.kind === 'task'
                      ? 'Save task'
                      : modal.kind === 'launch'
                        ? 'Queue execution'
                        : modal.kind === 'node'
                          ? 'Add node'
                          : modal.label}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </ModalFrame>
      )}
    </div>
  );
}

import { ProjectFolderForm } from './ProjectFolderForm.tsx';
import { ProjectHistory } from './ProjectHistory.tsx';
import { LanguageSelector } from './LanguageSelector.tsx';
import { t as tr, useLocale, errorText, uiMessage } from './i18n.ts';
import { ExternalSessions } from './ExternalSessions.tsx';
import { TaskTree } from './TaskTree.tsx';
import { ModelSelector } from './ModelSelector.tsx';
import { ExecutionSummary } from './ExecutionSummary.tsx';
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
import { Monitor as MonitorPage } from './Monitor.tsx';
import { ResultEvidence } from './ResultEvidence.tsx';
import { api, useWorkspace } from './api.ts';
import type { Task, Project, Session, Run, Approval } from '../../../packages/shared/index.ts';
import './styles.css';
import type { ProviderStatus } from '../../../packages/shared/index.ts';

function preferredProvider(providers: ProviderStatus[]) {
  return providers.find((p) => p.id !== 'mock' && p.authenticated)?.id ?? 'codex';
}

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
      title: () => string;
      detail: () => string;
      label: () => string;
      action: () => Promise<unknown>;
    };
const fmt = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (id?: string) => id?.slice(0, 8) ?? '—';
export function App() {
  useLocale();
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
    data?.projects.find((p) => p.id === projectId && !p.removedAt) ??
    data?.projects.find((p) => !p.archived);
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
        document.querySelector<HTMLInputElement>('[data-workspace-search]')?.focus();
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
  function confirm(
    title: () => string,
    detail: () => string,
    label: () => string,
    fn: () => Promise<unknown>,
  ) {
    setModal({ kind: 'confirm', title, detail, label, action: fn });
  }
  function removeProject(target: Project) {
    confirm(
      () => tr('Remove project'),
      () =>
        tr(
          'Remove {name} from Workspace? Local files and Codex / Claude Code data stay untouched. Load this folder again to restore Workspace history.',
          { name: target.name },
        ),
      () => tr('Remove project'),
      async () => {
        await api(`/projects/${target.id}`, 'DELETE');
        navigate({ view: 'focus', projectId: '', taskId: '', sessionId: '', search: '' });
      },
    );
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
          tr('Project imported'),
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
          tr('Task saved'),
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
              reasoningEffort: f.get('reasoningEffort') || undefined,
              sessionId: modal.sessionId,
              allowReal: f.get('allowReal') === 'on',
              allowValidation: f.get('allowValidation') === 'on',
            }),
          tr('Run queued'),
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
              ...(f.get('nodePath') ? { nodePath: f.get('nodePath') } : {}),
              cpu: Number(f.get('cpu')),
              ramMb: Number(f.get('ramMb')),
            }),
          tr('SSH node added. Probe it before execution.'),
        );
      if (modal.kind === 'confirm') await action(modal.action, tr('Action completed'));
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
        <LanguageSelector />
        <div className="brand-mark">
          <Layers />
        </div>
        <h2> {tr('AI Agent Workspace')} </h2>
        <p> {tr('Connecting to your local control plane…')} </p>
      </div>
    );
  if (error || !data)
    return (
      <div className="boot">
        <LanguageSelector />
        <AlertCircle />
        <h2> {tr('Local server unavailable')} </h2>
        <p>{errorText(error?.message ?? '')}</p>
        <button className="primary" onClick={() => void refresh()}>
          {' '}
          {tr('Retry connection')}{' '}
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
        onRemoveProject={removeProject}
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
              <span>{task ? tr('TASK INSPECTOR') : tr('WORKSPACE INSPECTOR')}</span>
              <button aria-label={tr('Close inspector')} onClick={() => setInspector(false)}>
                <X size={15} />
              </button>
            </div>
            {task ? (
              <>
                <div className="inspector-title">
                  <span className="subtle">
                    {' '}
                    {tr('TASK ·')} {short(task.id)}
                  </span>
                  <h2>{task.title}</h2>
                  <Badge state={task.state} />
                </div>
                <div className="inspector-section">
                  <h3> {tr('Execution')} </h3>
                  <dl>
                    <dt> {tr('Provider')} </dt>
                    <dd>{task.provider}</dd>
                    <dt> {tr('Node')} </dt>
                    <dd>{data.nodes.find((n) => n.id === task.nodeId)?.name}</dd>
                    <dt> {tr('Priority')} </dt>
                    <dd>{task.priority} / 100</dd>
                    <dt> {tr('Dependencies')} </dt>
                    <dd>
                      {task.dependencies.length
                        ? task.dependencies
                            .map((id) => tasks.find((t) => t.id === id)?.title)
                            .join(', ')
                        : tr('None')}
                    </dd>
                  </dl>
                  <button
                    className="secondary full"
                    onClick={() => setModal({ kind: 'task', task })}
                  >
                    {' '}
                    {tr('Configure task')}{' '}
                  </button>
                </div>
                <div className="inspector-section">
                  <h3>
                    {' '}
                    {tr('Resource allocation')} <span> {tr('SOFT')} </span>
                  </h3>
                  <div className="allocation-grid">
                    <div>
                      <Cpu size={15} />
                      <strong>{task.allocation.cpu}</strong>
                      <small> {tr('CPU cores')} </small>
                    </div>
                    <div>
                      <MemoryStick size={15} />
                      <strong>{task.allocation.ramMb}</strong>
                      <small> {tr('RAM · MB')} </small>
                    </div>
                  </div>
                  <dl>
                    <dt> {tr('GPU device')} </dt>
                    <dd>{task.allocation.gpu ?? tr('None selected')}</dd>
                    <dt> {tr('VRAM budget')} </dt>
                    <dd>
                      {task.allocation.vramMb} {tr('MB · soft')}{' '}
                    </dd>
                    <dt> {tr('Timeout')} </dt>
                    <dd>
                      {task.allocation.timeoutSec} {tr('s · enforced')}{' '}
                    </dd>
                  </dl>
                </div>
                {task.error && (
                  <div className="inspector-section">
                    <div className="error-card">
                      <AlertCircle size={16} />
                      <p>{errorText(task.error)}</p>
                    </div>
                  </div>
                )}
                {run?.state === 'orphaned' && (
                  <div className="inspector-section">
                    <button
                      className="warning full"
                      onClick={() =>
                        confirm(
                          () => tr('Reconcile uncertain execution'),
                          () =>
                            tr(
                              'Inspect the execution node first. Confirm that this run and all child processes have stopped. This releases quarantined capacity; it does not claim the run succeeded.',
                            ),
                          () => tr('Confirm process stopped'),
                          () =>
                            api(`/runs/${run.id}/reconcile`, 'POST', {
                              confirmedStopped: true,
                            }),
                        )
                      }
                    >
                      {' '}
                      {tr('Reconcile execution')}{' '}
                    </button>
                  </div>
                )}
                {session && (
                  <div className="inspector-section">
                    <h3> {tr('Git workspace')} </h3>
                    <dl>
                      <dt> {tr('Session')} </dt>
                      <dd>{short(session.id)}</dd>
                      <dt> {tr('Branch')} </dt>
                      <dd className="break">{workspace?.branch ?? tr('Pending')}</dd>
                      <dt> {tr('Base')} </dt>
                      <dd>{short(workspace?.baseCommit)}</dd>
                      <dt> {tr('Snapshot')} </dt>
                      <dd>{short(workspace?.headCommit)}</dd>
                    </dl>
                    <div className="button-stack">
                      <button
                        className="secondary full"
                        onClick={() => {
                          navigate({ view: 'sessions', tab: 'diff', search: '' });
                        }}
                      >
                        <FileCode size={14} /> {tr('Review changes')}{' '}
                      </button>
                      {workspace && !workspace.cleaned && (
                        <button
                          className="text-button"
                          onClick={() =>
                            confirm(
                              () => tr('Clean up worktree'),
                              () =>
                                tr(
                                  'Remove only this managed, clean worktree. The branch and all recorded history will be retained. Uncommitted changes block cleanup.',
                                ),
                              () => tr('Clean up worktree'),
                              () =>
                                api(`/sessions/${session.id}/cleanup`, 'POST', {
                                  confirmed: true,
                                }),
                            )
                          }
                        >
                          {' '}
                          {tr('Clean up worktree')}{' '}
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
                  <h2> {tr('Built for parallel work')} </h2>
                  <p>
                    {' '}
                    {tr(
                      'Select a task or session to inspect its configuration, worktree, and execution.',
                    )}{' '}
                  </p>
                </div>
                <div className="inspector-section">
                  <h3> {tr('Execution policy')} </h3>
                  <div className="policy-item">
                    <Check size={15} />
                    <span> {tr('Isolated Git worktrees')} </span>
                  </div>
                  <div className="policy-item">
                    <Check size={15} />
                    <span> {tr('Persistent event history')} </span>
                  </div>
                  <div className="policy-item">
                    <Check size={15} />
                    <span> {tr('Explicit merge approval')} </span>
                  </div>
                  <div className="policy-item">
                    <Shield size={15} />
                    <span> {tr('Loopback API + local authentication')} </span>
                  </div>
                </div>
              </>
            )}
            <div className="inspector-section">
              <h3>
                {' '}
                {tr('Pending approvals')} <span>{pending.length}</span>
              </h3>
              {pending.map((a) => (
                <div className="approval-card" key={a.id}>
                  <GitMerge size={17} />
                  <b> {tr('Merge reviewed changes')} </b>
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
                  <p>
                    {' '}
                    {tr(
                      'Inspect the session diff. Approval applies only to these exact commits.',
                    )}{' '}
                  </p>
                  <div className="button-group">
                    <button
                      className="primary small"
                      onClick={() =>
                        confirm(
                          () => tr('Approve merge'),
                          () =>
                            tr(
                              'Integrate source {source} into {branch} at {target}? The server rejects stale approvals and dirty targets.',
                              { source: a.source, branch: a.targetBranch, target: a.target },
                            ),
                          () => tr('Approve and merge'),
                          () => api(`/approvals/${a.id}`, 'POST', { approved: true }),
                        )
                      }
                    >
                      {' '}
                      {tr('Review approval')}{' '}
                    </button>
                    <button
                      className="secondary small"
                      onClick={() =>
                        safe(
                          () => api(`/approvals/${a.id}`, 'POST', { approved: false }),
                          tr('Approval rejected'),
                        )
                      }
                    >
                      {' '}
                      {tr('Reject')}{' '}
                    </button>
                  </div>
                </div>
              ))}
              {!pending.length && <p className="subtle"> {tr('Nothing awaiting your review.')} </p>}
            </div>
            {data.approvals
              .filter((a) => a.state === 'applying')
              .map((a) => (
                <div className="approval-card" key={a.id}>
                  <b> {tr('Check merge outcome')} </b>
                  <small>
                    {a.targetBranch} · {short(a.previewCommit)}
                  </small>
                  <p>{a.error ?? tr('Checking the target branch against the approved commit.')}</p>
                  <button
                    className="secondary small"
                    onClick={() =>
                      safe(
                        () => api(`/approvals/${a.id}/reconcile`, 'POST', {}),
                        tr('Merge status checked'),
                      )
                    }
                  >
                    {' '}
                    {tr('Check target branch')}{' '}
                  </button>
                </div>
              ))}
            <div className="inspector-footer">
              <Shield size={14} /> {tr('Local by default. Explicit by design.')}{' '}
            </div>
          </>
        }
      >
        {view === 'monitor' && (
          <MonitorPage
            search={search}
            openProject={(projectId) => navigate({ view: 'project', projectId, search: '' })}
          />
        )}
        {view === 'focus' && (
          <Focus
            data={data}
            provider={preferredProvider(data.providers)}
            importProject={() => setModal({ kind: 'project' })}
            openExperiments={(projectId) =>
              navigate({ view: 'experiments', projectId, search: '' })
            }
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
                  <span /> {tr('YOUR DEVELOPMENT CONTROL PLANE')}{' '}
                </div>
                <h1> {tr('Workspace overview')} </h1>
                <p> {tr('A clear view of your agents, projects, and execution.')} </p>
              </div>
              <button className="primary" onClick={() => setModal({ kind: 'project' })}>
                <Plus size={15} /> {tr('Import project')}{' '}
              </button>
            </div>
            <div className="stat-grid">
              {[
                {
                  label: tr('Active projects'),
                  value: data.projects.filter((p) => !p.archived).length,
                  icon: FolderGit2,
                  sub: tr('Connected Git repositories'),
                  color: 'blue',
                },
                {
                  label: tr('Running sessions'),
                  value: running.length,
                  icon: MessagesSquare,
                  sub: tr('{count} sessions in history', { count: data.sessions.length }),
                  color: 'green',
                },
                {
                  label: tr('Queued tasks'),
                  value: queued.length,
                  icon: Layers,
                  sub: tr('Waiting for dependencies or capacity'),
                  color: 'purple',
                },
                {
                  label: tr('Awaiting approval'),
                  value: pending.length,
                  icon: Shield,
                  sub: tr('Reviewed commits, explicit consent'),
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
                    {' '}
                    {tr('Projects')} <span>{data.projects.filter((p) => !p.archived).length}</span>
                  </h2>
                  <button className="text-button" onClick={() => setView('project')}>
                    {' '}
                    {tr('View all')} <ArrowUpRight size={13} />
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
                            {ts.length} {tr('tasks')}{' '}
                          </p>
                          <div className="project-progress">
                            <i style={{ width: `${ts.length ? (done / ts.length) * 100 : 0}%` }} />
                          </div>
                          <small>
                            {done} {tr('of')} {ts.length}{' '}
                            {tr('executions completed · integration reviewed separately')}{' '}
                          </small>
                        </div>
                      </button>
                    );
                  })}
                {!data.projects.length && (
                  <Empty title={tr('Bring your repository')}>
                    <span>
                      {' '}
                      {tr(
                        'Load an existing local folder to view its configuration and tool history.',
                      )}{' '}
                      <br />
                      <button className="text-button" onClick={() => setModal({ kind: 'project' })}>
                        {' '}
                        {tr('Import project')} <ArrowRight size={14} />
                      </button>
                    </span>
                  </Empty>
                )}
              </section>
              <section className="surface">
                <div className="section-heading">
                  <h2> {tr('Local compute')} </h2>
                  <Badge state="online" />
                </div>
                <div className="compute-summary">
                  <div className="node-title">
                    <div className="node-icon">
                      <Monitor size={23} />
                    </div>
                    <div>
                      <h3>{data.nodes.find((n) => n.id === 'local')?.name}</h3>
                      <small> {tr('Local execution node · real telemetry')} </small>
                    </div>
                  </div>
                  <MetricBar
                    label={tr('CPU utilization')}
                    value={metric?.cpuPercent ?? null}
                    detail={tr('{cores} logical cores · {reserved} reserved', {
                      cores: metric?.cores ?? '—',
                      reserved: data.reservations
                        .filter((r) => r.nodeId === 'local')
                        .reduce((s, r) => s + r.cpu, 0),
                    })}
                  />
                  <MetricBar
                    label={tr('Memory')}
                    value={metric ? (metric.ramUsedMb / metric.ramTotalMb) * 100 : null}
                    detail={
                      metric
                        ? `${(metric.ramUsedMb / 1024).toFixed(1)} / ${(metric.ramTotalMb / 1024).toFixed(1)} GB`
                        : tr('Waiting for first sample')
                    }
                  />
                  <div className="gpu-summary">
                    <Cpu size={15} />
                    <span> {tr('NVIDIA GPU')} </span>
                    <b>{metric?.gpus?.length ? metric.gpus[0].name : tr('Unavailable')}</b>
                  </div>
                  <button className="text-button" onClick={() => setView('compute')}>
                    {' '}
                    {tr('Manage compute nodes')} <ArrowUpRight size={13} />
                  </button>
                </div>
              </section>
            </div>
            <div className="dashboard-grid lower">
              <section className="surface">
                <div className="section-heading">
                  <h2> {tr('Recent activity')} </h2>
                  <button className="text-button" onClick={() => setView('activity')}>
                    {' '}
                    {tr('Full timeline')} <ArrowUpRight size={13} />
                  </button>
                </div>
                <Timeline events={events.slice(-6).reverse()} />
              </section>
              <section className="surface">
                <div className="section-heading">
                  <h2> {tr('Agent providers')} </h2>
                  <span className="subtle"> {tr('Native authentication')} </span>
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
                            ? tr('Test fixture · no inference')
                            : (p.version ?? tr('Not installed'))}
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
                    {' '}
                    {tr(
                      'Credentials stay with the native CLI. Real agents run only after your explicit launch.',
                    )}{' '}
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
                <div className="eyebrow"> {tr('PROJECT WORKSPACE')} </div>
                <h1>{project?.name ?? tr('Projects')}</h1>
                <p>
                  <GitBranch size={13} />
                  {project?.executionReady === false
                    ? tr('Local folder')
                    : project?.baseBranch || tr('No repository selected')}
                  <span className="divider">/</span>
                  {project?.repoPath ?? tr('Import a local repository to get started')}
                </p>
              </div>
              <div className="button-group">
                <button
                  aria-label={tr('Load local project')}
                  className="secondary"
                  onClick={() => setModal({ kind: 'project' })}
                >
                  <Plus size={15} /> {tr('Import project')}
                </button>
                {project && (
                  <button className="secondary" onClick={() => removeProject(project)}>
                    {tr('Remove project')}
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!project || project.archived || project.executionReady === false}
                  onClick={() => setModal({ kind: 'task' })}
                >
                  <Plus size={15} /> {tr('New task')}{' '}
                </button>
              </div>
            </div>
            <div className="project-ribbon">
              <span>
                <span className="dot green-bg" />
                {tasks.filter((t) => t.state === 'running').length} {tr('running')}{' '}
              </span>
              <span>
                <Check size={13} />
                {tasks.filter((t) => t.state === 'completed').length} {tr('completed')}{' '}
              </span>
              <span>
                <Layers size={13} />
                {project?.concurrency ?? 0} {tr('parallel slots')}{' '}
              </span>
              <span>
                <GitMerge size={13} /> {tr('Explicit integration approval')}{' '}
              </span>
            </div>
            {project?.executionReady === false && (
              <p className="note">
                {tr('Task execution requires a Git repository root with an initial commit')}
              </p>
            )}
            {project && <ProjectHistory key={'history-' + project.id} projectId={project.id} />}
            {project && (
              <ExternalSessions
                key={project.id}
                projectId={project.id}
                archived={project.archived}
              />
            )}
            <section className="surface task-surface">
              <div className="task-toolbar">
                <div className="segmented">
                  <button
                    className={treeMode === 'tree' ? 'active' : ''}
                    onClick={() => setTreeMode('tree')}
                  >
                    <ListTree size={15} /> {tr('Task tree')}{' '}
                  </button>
                  <button
                    className={treeMode === 'graph' ? 'active' : ''}
                    onClick={() => setTreeMode('graph')}
                  >
                    <Network size={15} /> {tr('Dependencies')}{' '}
                  </button>
                </div>
                <small>
                  {tasks.length} {tr('tasks · drag to reparent')}{' '}
                </small>
                <button
                  className="secondary small"
                  disabled={!tasks.some((t) => t.state === 'draft')}
                  onClick={() =>
                    confirm(
                      () => tr('Queue draft tasks'),
                      () =>
                        tr(
                          'Queue {count} tasks? Dependencies and resource budgets determine start order. This authorizes provider usage and the configured validation commands: {commands}.',
                          {
                            count: tasks.filter((t) => t.state === 'draft').length,
                            commands:
                              tasks
                                .filter((t) => t.state === 'draft' && t.validationCommand?.length)
                                .map((t) => JSON.stringify(t.validationCommand))
                                .join(', ') || tr('none'),
                          },
                        ),
                      () => tr('Queue tasks'),
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
                  <Play size={13} /> {tr('Queue draft tasks')}{' '}
                </button>
              </div>
              {!tasks.length ? (
                <Empty title={tr('Plan the work, then let your agents execute')}>
                  {' '}
                  {tr('Create tasks, assign a provider, and connect dependencies.')} <br />
                  <button
                    className="text-button"
                    disabled={!project}
                    onClick={() => setModal({ kind: 'task' })}
                  >
                    {' '}
                    {tr('Create your first task')} <ArrowRight size={14} />
                  </button>
                </Empty>
              ) : treeMode === 'tree' ? (
                <>
                  <div className="task-table-head">
                    <span> {tr('TASK')} </span>
                    <span> {tr('STATUS')} </span>
                    <span> {tr('AGENT')} </span>
                    <span> {tr('NODE')} </span>
                    <span />
                  </div>
                  <div role="tree" aria-label={tr('Project task tree')}>
                    <TaskTree
                      tasks={tasks}
                      taskId={taskId}
                      search={search}
                      nodes={data.nodes}
                      activeTaskIds={new Set(data.runs.filter(active).map((r) => r.taskId))}
                      selectTask={selectTask}
                      onMenu={setContext}
                      onLaunch={(task) => setModal({ kind: 'launch', task })}
                      onDelete={(task) =>
                        confirm(
                          () => tr('Delete task'),
                          () =>
                            tr(
                              'Delete {title}? Tasks with execution history, children or dependents are protected.',
                              { title: task.title },
                            ),
                          () => tr('Delete task'),
                          () => api(`/tasks/${task.id}`, 'DELETE'),
                        )
                      }
                      onMove={(id, parentId) =>
                        safe(() => api(`/tasks/${id}`, 'PATCH', { parentId }), tr('Task moved'))
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
                          tr('Moved to root'),
                        );
                    }}
                    onClick={() => setModal({ kind: 'task' })}
                  >
                    <Plus size={14} /> {tr('Add a task')}{' '}
                    <span> {tr('or drop here to move to root')} </span>
                  </button>
                </>
              ) : (
                <Suspense fallback={<p role="status"> {tr('Loading graph…')} </p>}>
                  <DependencyGraph tasks={tasks} select={selectTask} />
                </Suspense>
              )}
            </section>
            <div className="project-footnote">
              <Shield size={14} />{' '}
              {tr(
                'Tree hierarchy organizes work. Dependency edges control execution. Completion does not automatically merge code.',
              )}{' '}
            </div>
            {task && (
              <section className="surface task-detail">
                <div className="section-heading">
                  <h2>{task.title}</h2>
                  <button className="text-button" onClick={() => setModal({ kind: 'task', task })}>
                    {' '}
                    {tr('Edit task')} <ArrowUpRight size={13} />
                  </button>
                </div>
                <p>{task.description || tr('No description added.')}</p>
                {task.criteria && (
                  <div className="criteria">
                    <small> {tr('ACCEPTANCE CRITERIA')} </small>
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
                    <small>
                      {' '}
                      {tr('No sessions yet. Start a run to create an isolated worktree.')}{' '}
                    </small>
                  )}
                </div>
                <ExecutionSummary key={task.id} taskId={task.id} />
              </section>
            )}
          </>
        )}
        {view === 'sessions' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow"> {tr('MULTI-AGENT EXECUTION')} </div>
                <h1> {tr('Session console')} </h1>
                <p> {tr('Conversation, execution, and source changes in one place.')} </p>
              </div>
              {task && (
                <button
                  className="primary"
                  disabled={Boolean(run && active(run))}
                  onClick={() => setModal({ kind: 'launch', task, sessionId: session?.id })}
                >
                  <Play size={14} />
                  {session ? tr('Continue session') : tr('Start session')}
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
              <Empty icon={<MessagesSquare />} title={tr('No session selected')}>
                {' '}
                {tr('Start a task from a project to create its first isolated execution.')}{' '}
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
                              tr('Interrupt requested'),
                            )
                          }
                        >
                          <Pause size={13} /> {tr('Interrupt')}{' '}
                        </button>
                        <button
                          className="icon-button"
                          aria-label={tr('Cancel run')}
                          onClick={() =>
                            confirm(
                              () => tr('Cancel execution'),
                              () =>
                                tr(
                                  'Stop this execution? The worktree and history will be retained.',
                                ),
                              () => tr('Cancel run'),
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
                    ['console', tr('Conversation'), MessagesSquare],
                    ['terminal', tr('Tool output'), TerminalSquare],
                    ['diff', tr('Git diff'), FileCode],
                    ['history', tr('Run history'), History],
                    ['artifacts', tr('Artifacts'), Box],
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
                                ? uiMessage('YOU')
                                : e.type === 'MessageDelta'
                                  ? session.provider.toUpperCase()
                                  : uiMessage(e.type)}
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
                                  ? tr('Execution completed. Review the diff before integration.')
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
                      <Empty title={tr('Waiting for execution events')}>
                        {' '}
                        {tr(
                          'The scheduler will launch this session when dependencies and capacity are ready.',
                        )}{' '}
                      </Empty>
                    )}
                  </div>
                )}
                {tab === 'terminal' && (
                  <Suspense fallback={<p role="status"> {tr('Loading tool output…')} </p>}>
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
                        {workspace?.branch ?? tr('Worktree pending')}
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
                            tr('Merge preview created. Review the approval in the inspector.'),
                          )
                        }
                      >
                        <GitMerge size={13} /> {tr('Preview merge')}{' '}
                      </button>
                    </div>
                    {diffLoading ? (
                      <p className="padding"> {tr('Loading diff…')} </p>
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
                          : tr('No recorded changes.')}
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
                                : tr('Pending / active')}
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
                            <ArrowDownToLine size={13} /> {tr('Download artifact')}{' '}
                          </button>
                        </details>
                      ))}
                  </div>
                )}
                <div className="console-bottom">
                  <span>
                    <GitBranch size={12} />
                    {workspace?.branch ?? tr('Worktree created when run starts')}
                  </span>
                  <span>
                    <Zap size={12} />
                    {run?.usage?.input_tokens !== undefined
                      ? tr('{input} in · {output} out tokens', {
                          input: String(run.usage.input_tokens),
                          output: String(run.usage.output_tokens ?? '—'),
                        })
                      : tr('Token usage unavailable')}
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
                      ? tr('Execution active. Interrupt before sending another turn.')
                      : tr('Continue the conversation with a new instruction.')}
                  </span>
                  <button
                    className="secondary small"
                    disabled={session.closed || Boolean(run && active(run))}
                    type="submit"
                  >
                    {' '}
                    {tr('New instruction')} <ArrowRight size={13} />
                  </button>
                </form>
              </section>
            )}
          </>
        )}
        {view === 'experiments' && (
          <Suspense fallback={<p> {tr('Loading experiments…')} </p>}>
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
                  notify(tr('Choose an active project before creating a task.'), true);
                else setModal({ kind: 'project' });
              }}
            />
          </Suspense>
        )}
        {view === 'compute' && (
          <Suspense fallback={<p role="status"> {tr('Loading compute workspace…')} </p>}>
            <Compute
              data={data}
              onAdd={() => setModal({ kind: 'node' })}
              onRefresh={(id) => {
                void safe(
                  () => api(`/nodes/${id}/probe`, 'POST', {}),
                  tr('Node telemetry refreshed'),
                );
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
                <div className="eyebrow"> {tr('PERSISTENT EVENT STORE')} </div>
                <h1> {tr('Activity timeline')} </h1>
                <p>
                  {' '}
                  {tr(
                    'Execution history, replayed from SQLite. Latest 5,000 events in this view.',
                  )}{' '}
                </p>
              </div>
              <span className="event-counter">
                {events.length} {tr('loaded events')}{' '}
              </span>
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
                <div className="eyebrow"> {tr('WORKSPACE CONFIGURATION')} </div>
                <h1> {tr('Settings & providers')} </h1>
                <p> {tr('Your local tools. Your accounts. Explicit capabilities.')} </p>
              </div>
              <button
                className="secondary"
                onClick={() =>
                  safe(() => api('/providers/refresh', 'POST', {}), tr('Provider checks refreshed'))
                }
              >
                <RefreshCw size={14} /> {tr('Check providers')}{' '}
              </button>
            </div>
            <div className="settings-grid">
              {data.providers.map((p) => (
                <section className="surface provider-settings" key={p.id}>
                  <div className="section-heading">
                    <h2>{uiMessage(p.name)}</h2>
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
                  <p>{uiMessage(p.detail)}</p>
                  <code>{p.version ?? tr('Version unavailable')}</code>
                  <dl>
                    <dt> {tr('Streaming / resume')} </dt>
                    <dd>
                      {p.capabilities.streaming ? tr('Supported') : tr('Unavailable')} /{' '}
                      {p.capabilities.resume ? tr('Supported') : tr('Unavailable')}
                    </dd>
                    <dt> {tr('Interactive tool approval')} </dt>
                    <dd>
                      {p.capabilities.interactiveApproval ? tr('Supported') : tr('Unavailable')}
                    </dd>
                    <dt> {tr('CPU / RAM hard limits')} </dt>
                    <dd> {tr('Unavailable')} </dd>
                    <dt> {tr('Cost')} </dt>
                    <dd>
                      {p.capabilities.cost === 'estimate'
                        ? tr('Provider estimate · cumulative conversation')
                        : tr('Unavailable')}
                    </dd>
                  </dl>
                  {p.id !== 'mock' && (
                    <div className="setup-code">
                      <small>{tr('Run in your own terminal to authenticate:')}</small>
                      <code>
                        {p.id === 'codex' ? 'ai-agent-workspace login codex' : 'claude auth login'}
                      </code>
                      {p.id === 'codex' && (
                        <p>
                          {tr(
                            'On Windows, open “Sign in to Codex” from the Start menu. Source installs can use npm run workspace -- login codex after building.',
                          )}
                        </p>
                      )}
                      <p>{tr('The application does not read or copy credential files.')}</p>
                    </div>
                  )}
                </section>
              ))}
            </div>
            <section className="surface preference-panel">
              <h2> {tr('Interface')} </h2>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={inspector}
                  onChange={(e) => setInspector(e.target.checked)}
                />{' '}
                {tr('Show contextual inspector')}{' '}
              </label>
              <label className="range-label">
                {' '}
                {tr('Inspector width')}{' '}
                <input
                  aria-label={tr('Inspector width')}
                  type="range"
                  min="270"
                  max="480"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                />
                <span>{width}px</span>
              </label>
              <p>
                <kbd>Ctrl / ⌘ K</kbd> {tr('Search')} <kbd>Ctrl / ⌘ Shift N</kbd> {tr('New task')}{' '}
                <kbd>Esc</kbd> {tr('Dismiss')}{' '}
              </p>
            </section>
            {data.projects.some((p) => p.archived) && (
              <section className="surface preference-panel">
                <h2> {tr('Archived projects')} </h2>
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
                            tr('Project restored'),
                          )
                        }
                      >
                        {' '}
                        {tr('Restore')}{' '}
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
              label: tr('Run / re-run with model…'),
              icon: Play,
              disabled: data.runs.some((run) => run.taskId === context.task.id && active(run)),
              run: () => setModal({ kind: 'launch', task: context.task }),
            },
            {
              label: tr('Edit task'),
              icon: Settings,
              run: () => setModal({ kind: 'task', task: context.task }),
            },
            {
              label: tr('Add child task'),
              icon: Plus,
              run: () => setModal({ kind: 'task', parentId: context.task.id }),
            },
            {
              label: tr('Duplicate task'),
              icon: Copy,
              run: () =>
                safe(
                  () =>
                    api(`/projects/${context.task.projectId}/tasks`, 'POST', {
                      ...context.task,
                      title: `${context.task.title} (copy)`,
                    }),
                  tr('Task duplicated'),
                ),
            },
            {
              label: tr('Delete task'),
              icon: Trash2,
              disabled: data.runs.some((run) => run.taskId === context.task.id && active(run)),
              run: () =>
                confirm(
                  () => tr('Delete task'),
                  () =>
                    tr(
                      'Delete {title}? Tasks with execution history or dependents are protected.',
                      { title: context.task.title },
                    ),
                  () => tr('Delete task'),
                  () => api(`/tasks/${context.task.id}`, 'DELETE'),
                ),
            },
          ].map((item) => (
            <button
              key={item.label}
              disabled={item.disabled}
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
          <span>{toast.error ? errorText(toast.text) : uiMessage(toast.text)}</span>
          <button aria-label={tr('Dismiss notification')} onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <ModalFrame
          title={
            modal.kind === 'project'
              ? tr('Load local project')
              : modal.kind === 'task'
                ? modal.task
                  ? tr('Edit task')
                  : tr('Create task')
                : modal.kind === 'launch'
                  ? modal.sessionId
                    ? tr('Continue session')
                    : tr('Launch agent session')
                  : modal.kind === 'node'
                    ? tr('Connect SSH worker')
                    : modal.title()
          }
          close={() => !busy && setModal(null)}
        >
          <form onSubmit={(e) => void submitModal(e)}>
            {modal.kind === 'project' && <ProjectFolderForm />}
            {modal.kind === 'task' && (
              <>
                <p className="form-hint">
                  {' '}
                  {tr('Project ·')} {project?.name}
                </p>
                <Field
                  label={tr('Task title')}
                  name="title"
                  value={modal.task?.title}
                  placeholder={tr('Implement Backend API')}
                  required
                />
                <label>
                  {' '}
                  {tr('Description')}{' '}
                  <textarea
                    name="description"
                    aria-label={tr('Description')}
                    rows={4}
                    defaultValue={modal.task?.description}
                    placeholder={tr('Explain the goal, constraints, and expected changes…')}
                  />
                </label>
                <label>
                  {' '}
                  {tr('Acceptance criteria')}{' '}
                  <textarea
                    name="criteria"
                    aria-label={tr('Acceptance criteria')}
                    rows={2}
                    defaultValue={modal.task?.criteria}
                    placeholder={tr('What must be true when this task is complete?')}
                  />
                </label>
                <div className="form-grid">
                  <label>
                    {tr('Provider')}
                    <select
                      name="provider"
                      aria-label={tr('Provider')}
                      defaultValue={modal.task?.provider ?? preferredProvider(data.providers)}
                    >
                      <option value="codex">OpenAI Codex</option>
                      <option value="claude">Claude Code</option>
                      <option value="mock">{tr('Mock Agent · deterministic test')}</option>
                    </select>
                  </label>
                  <label>
                    {' '}
                    {tr('Execution node')}{' '}
                    <select name="nodeId" defaultValue={modal.task?.nodeId ?? 'local'}>
                      {data.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name} · {uiMessage(n.status)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {' '}
                    {tr('Parent task')}{' '}
                    <select
                      name="parentId"
                      defaultValue={modal.task?.parentId ?? modal.parentId ?? ''}
                    >
                      <option value=""> {tr('Project root')} </option>
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
                    label={tr('Priority (0–100)')}
                    name="priority"
                    type="number"
                    value={String(modal.task?.priority ?? 50)}
                    min="0"
                    max="100"
                  />
                </div>
                <fieldset>
                  <legend> {tr('Execution dependencies')} </legend>
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
                    {!tasks.length && <small> {tr('No other tasks yet.')} </small>}
                  </div>
                </fieldset>
                <label className="check-label">
                  <input
                    name="integration"
                    type="checkbox"
                    defaultChecked={modal.task?.integration}
                  />{' '}
                  {tr('Build an integration worktree from successful dependency commits')}{' '}
                </label>
                <ExperimentFields
                  key={modal.task?.id ?? 'new'}
                  experiment={modal.task?.experiment}
                  initiallyEnabled={modal.experiment}
                />
                <details className="advanced" open={Boolean(modal.task)}>
                  <summary> {tr('Resources & remote execution')} </summary>
                  <div className="form-grid">
                    <Field
                      label={tr('CPU soft budget')}
                      name="cpu"
                      type="number"
                      value={String(modal.task?.allocation.cpu ?? 1)}
                      min="0.1"
                      step="0.1"
                    />
                    <Field
                      label={tr('RAM soft budget (MB)')}
                      name="ramMb"
                      type="number"
                      value={String(modal.task?.allocation.ramMb ?? 512)}
                      min="1"
                    />
                    <Field
                      label={tr('GPU UUID or index (optional; UUID recommended)')}
                      name="gpu"
                      value={modal.task?.allocation.gpu ?? ''}
                      placeholder={tr('GPU-… or 0')}
                    />
                    <Field
                      label={tr('VRAM soft budget (MB)')}
                      name="vramMb"
                      type="number"
                      value={String(modal.task?.allocation.vramMb ?? 0)}
                      min="0"
                    />
                    <Field
                      label={tr('Execution timeout (seconds)')}
                      name="timeoutSec"
                      type="number"
                      value={String(modal.task?.allocation.timeoutSec ?? 600)}
                      min="1"
                      max="86400"
                    />
                  </div>
                  <Field
                    label={tr('Validation command as JSON argv (optional, local only)')}
                    name="validationCommand"
                    value={JSON.stringify(modal.task?.validationCommand ?? [])}
                    placeholder={'["node","--test"]'}
                  />
                  <Field
                    label={tr('Remote repository path (SSH tasks only)')}
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
                      {modal.sessionId ? tr('existing conversation') : tr('new isolated worktree')}
                    </small>
                  </div>
                </div>
                <label>
                  {' '}
                  {tr('Instruction')}{' '}
                  <textarea
                    name="prompt"
                    rows={6}
                    required
                    defaultValue={
                      modal.sessionId
                        ? ''
                        : `${modal.task.description}\n\nAcceptance criteria: ${modal.task.criteria}`
                    }
                    placeholder={tr('Describe your next instruction…')}
                  />
                </label>
                <ModelSelector
                  key={`${modal.task.id}:${modal.sessionId ?? 'new'}`}
                  provider={modal.task.provider}
                  session={data.sessions.find((session) => session.id === modal.sessionId)}
                />
                {modal.task.provider !== 'mock' ? (
                  <label className="consent">
                    <input type="checkbox" name="allowReal" required />
                    <span>
                      {' '}
                      {tr(
                        'Run this real provider using my native account. This can consume subscription quota or API credits. The CLI permission policy remains active.',
                      )}{' '}
                    </span>
                  </label>
                ) : (
                  <div className="note">
                    <Box size={15} />{' '}
                    {tr(
                      'Mock runs execute deterministic filesystem fixtures. No model inference or token usage.',
                    )}{' '}
                  </div>
                )}
                {Boolean(modal.task.validationCommand?.length) && (
                  <label className="consent">
                    <input type="checkbox" name="allowValidation" required />
                    <span>
                      {' '}
                      {tr('Execute this command in the owned worktree:')}{' '}
                      <code>{JSON.stringify(modal.task.validationCommand)}</code>{' '}
                      {tr('. Test code runs with my local user permissions.')}{' '}
                    </span>
                  </label>
                )}
                <p className="form-hint">
                  {' '}
                  {tr(
                    'Queued runs start automatically when dependencies and resources are ready. Interrupt ends the current turn; continuing creates a new run.',
                  )}{' '}
                </p>
              </>
            )}
            {modal.kind === 'node' && (
              <>
                <p className="form-hint">
                  {' '}
                  {tr(
                    'Install the worker on a Linux host first. Use an SSH config alias with key authentication and a verified known_hosts entry. The worker requires WORKER_REPO_ROOT.',
                  )}{' '}
                </p>
                <Field
                  label={tr('Node name')}
                  name="name"
                  placeholder={tr('GPU workstation')}
                  required
                />
                <Field
                  label={tr('SSH config alias')}
                  name="sshAlias"
                  placeholder="gpu-workstation"
                  required
                />
                <Field
                  label={tr('Absolute worker entry path (no spaces)')}
                  name="workerPath"
                  placeholder="/srv/ai-agent-workspace/dist/worker/src/index.js"
                  required
                />
                <Field
                  label={tr('Node executable path (optional)')}
                  name="nodePath"
                  placeholder="/srv/node/bin/node"
                />
                <div className="form-grid">
                  <Field
                    label={tr('Schedulable CPU cores')}
                    name="cpu"
                    type="number"
                    value="4"
                    min="1"
                  />
                  <Field
                    label={tr('Schedulable RAM (MB)')}
                    name="ramMb"
                    type="number"
                    value="8192"
                    min="1"
                  />
                </div>
                <div className="note">
                  <Shield size={15} />{' '}
                  {tr(
                    'Attached SSH transport. A lost connection requires reconciliation before capacity is released.',
                  )}{' '}
                </div>
              </>
            )}
            {modal.kind === 'confirm' && <p className="confirm-detail">{modal.detail()}</p>}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                {' '}
                {tr('Cancel')}{' '}
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy
                  ? tr('Working…')
                  : modal.kind === 'project'
                    ? tr('Import project')
                    : modal.kind === 'task'
                      ? tr('Save task')
                      : modal.kind === 'launch'
                        ? tr('Queue execution')
                        : modal.kind === 'node'
                          ? tr('Add node')
                          : modal.label()}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </ModalFrame>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Copy,
  Eye,
  FolderGit2,
  MessagesSquare,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { api } from './api.ts';
import { t as tr, errorText, uiMessage, useLocale, type MessageKey } from './i18n.ts';
import { Empty } from './UiPrimitives.tsx';
import type {
  MonitorAlert,
  MonitorOverview,
  MonitoredSession,
  ProjectHealth,
  SessionClient,
  SessionPhase,
} from '../../../packages/shared/monitoring.ts';
import type { NativeOutput } from '../../../packages/shared/native-history.ts';
import './monitor.css';

const providerName = (p: string) => (p === 'codex' ? 'OpenAI Codex' : 'Claude Code');
const clientKey: Record<SessionClient, MessageKey> = {
  cli: 'Terminal CLI',
  vscode: 'VS Code plugin',
  jetbrains: 'JetBrains / PyCharm plugin',
  sdk: 'SDK / embedded',
  exec: 'Non-interactive exec',
  subagent: 'Subagent',
  unknown: 'Unknown client',
};
const phaseKey: Record<SessionPhase, MessageKey> = {
  working: 'Turn in progress',
  waiting: 'Awaiting input',
  aborted: 'Interrupted',
  error: 'Error recorded',
  unknown: 'State unknown',
};
const phaseTone: Record<SessionPhase, string> = {
  working: 'running',
  waiting: 'completed',
  aborted: 'paused',
  error: 'failed',
  unknown: 'queued',
};
const healthKey: Record<ProjectHealth, MessageKey> = {
  blocked: 'Blocked',
  attention: 'Needs attention',
  active: 'Active',
  idle: 'Idle',
};
const healthTone: Record<ProjectHealth, string> = {
  blocked: 'failed',
  attention: 'pending',
  active: 'running',
  idle: 'queued',
};
const severityTone = { error: 'failed', warning: 'pending', info: 'queued' } as const;
const alertKey: Record<MonitorAlert['kind'], MessageKey> = {
  session_error: 'Session recorded an error',
  session_stalled: 'Turn in progress with no new records',
  session_aborted: 'Turn interrupted',
  session_ended: 'Process exited mid-turn',
  run_orphaned: 'Managed run outcome unknown',
  run_failed: 'Managed run needs review',
  attempt_failed: 'Experiment attempt failed',
  approval_pending: 'Merge approval pending',
  result_stale: 'Result is outdated',
  source_degraded: 'History source incomplete',
  unassigned_active: 'Active session outside registered projects',
};
type Filter = 'all' | 'active' | 'open' | 'recent' | 'attention' | 'unassigned';

export function relativeTime(iso: string | undefined, now = Date.now()) {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return tr('just now');
  if (seconds < 3600) return tr('{count} min ago', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return tr('{count} h ago', { count: Math.floor(seconds / 3600) });
  return tr('{count} d ago', { count: Math.floor(seconds / 86400) });
}

const stateOf = (s: MonitoredSession) =>
  s.endedMidTurn
    ? { tone: 'failed', label: tr('Process exited mid-turn') }
    : s.stalled
      ? { tone: 'pending', label: tr('Possibly stalled') }
      : { tone: phaseTone[s.phase], label: tr(phaseKey[s.phase]) };
const processText = (s: MonitoredSession) =>
  s.process === 'attached'
    ? tr('Held open by a running process')
    : s.process === 'detached'
      ? tr('No running process holds this session')
      : undefined;
const live = (s: MonitoredSession) => s.liveness === 'active' || s.process === 'attached';

function Tone({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {label}
    </span>
  );
}

export function Monitor({
  search,
  openProject,
}: {
  search: string;
  openProject: (projectId: string) => void;
}) {
  useLocale();
  const [filter, setFilter] = useState<Filter>('recent');
  const [provider, setProvider] = useState('all');
  const [client, setClient] = useState('all');
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: ['monitor-overview'],
    queryFn: () => api<MonitorOverview>('/monitor/overview'),
    refetchInterval: 10000,
  });
  const data = overview.data;
  const projectName = useMemo(
    () => new Map(data?.projects.map((p) => [p.projectId, p.name]) ?? []),
    [data],
  );
  const attention = useMemo(
    () =>
      new Set(
        data?.alerts.filter((a) => a.sessionId && a.severity !== 'info').map((a) => a.sessionId),
      ),
    [data],
  );
  const query = search.trim().toLowerCase();
  const sessions = (data?.sessions ?? []).filter(
    (s) =>
      (filter === 'all' ||
        (filter === 'active' && s.liveness === 'active') ||
        (filter === 'open' && s.process === 'attached') ||
        (filter === 'recent' && (s.liveness !== 'dormant' || s.process === 'attached')) ||
        (filter === 'attention' && attention.has(s.id)) ||
        (filter === 'unassigned' && s.association === 'unassigned')) &&
      (provider === 'all' || s.provider === provider) &&
      (client === 'all' || s.client === client) &&
      (!projectId || s.projectId === projectId) &&
      (!query ||
        [s.title, s.lastRequest, s.cwd, s.providerSessionId, projectName.get(s.projectId ?? '')]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(query))),
  );
  const current = data?.sessions.find((s) => s.id === selected);
  if (overview.isPending) return <p className="monitor-loading">{tr('Loading monitor…')}</p>;
  if (overview.error && !data)
    return (
      <p role="alert" className="monitor-loading">
        {errorText(overview.error.message)}
      </p>
    );
  if (!data) return null;
  const stats = [
    {
      label: tr('Active sessions'),
      value: data.totals.active,
      sub: tr('Transcript written in the last 2 minutes'),
      icon: Activity,
      color: 'green',
    },
    {
      label: tr('Turns in progress'),
      value: data.totals.working,
      sub: tr('Unfinished turns that are writing now or held by a running process'),
      icon: TerminalSquare,
      color: 'blue',
    },
    {
      label: tr('Awaiting input'),
      value: data.totals.waiting,
      sub: tr('Turn finished in the last 24 hours'),
      icon: MessagesSquare,
      color: 'purple',
    },
    {
      label: tr('Alerts'),
      value: data.alerts.filter((a) => a.severity !== 'info').length,
      sub: tr('{count} informational', {
        count: data.alerts.filter((a) => a.severity === 'info').length,
      }),
      icon: AlertTriangle,
      color: 'amber',
    },
  ];
  return (
    <div className="monitor">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> {tr('READ-ONLY MONITOR')}
          </div>
          <h1>{tr('Monitor')}</h1>
          <p>
            {tr(
              'Sessions started from terminal CLIs and IDE plugins, discovered from local Codex and Claude Code history. Workspace only reads these files and never controls the original processes.',
            )}
          </p>
        </div>
        <button
          className="secondary"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            setRefreshError('');
            api<MonitorOverview>('/monitor/overview?refresh=true')
              .then((fresh) => queryClient.setQueryData(['monitor-overview'], fresh))
              .catch((error: Error) => setRefreshError(error.message))
              .finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw size={15} /> {tr('Refresh')}
        </button>
      </div>
      {refreshError && <p role="alert">{errorText(refreshError)}</p>}
      <p className="form-hint monitor-scan">
        {tr('Last scan {time}', { time: relativeTime(data.scannedAt) })}
        <span>
          {data.processesObserved
            ? tr('{count} sessions open in running processes', { count: data.totals.attached })
            : tr('Process state not observable on this system')}
        </span>
        {data.sources.map((source) => (
          <span key={source.path} title={source.path}>
            {providerName(source.provider)} · {uiMessage(source.state)} · {source.files}
            {source.pending
              ? ' · ' + tr('{count} waiting for the next scan', { count: source.pending })
              : ''}
          </span>
        ))}
      </p>
      <div className="stat-grid">
        {stats.map((s) => (
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
      <div className="monitor-grid">
        <section className="surface monitor-alerts" aria-label={tr('Alerts')}>
          <div className="section-heading">
            <h2>
              {tr('Alerts')} <span>{data.alerts.length}</span>
            </h2>
          </div>
          {!data.alerts.length ? (
            <Empty icon={<AlertTriangle />} title={tr('No alerts')}>
              {tr('Errors, stalled turns and managed runs that need review appear here.')}
            </Empty>
          ) : (
            <ul>
              {data.alerts.slice(0, 30).map((a) => (
                <li key={a.id}>
                  <Tone tone={severityTone[a.severity]} label={tr(alertKey[a.kind])} />
                  <button
                    className="text-button"
                    disabled={!a.sessionId && !a.projectId}
                    onClick={() => {
                      if (a.sessionId) setSelected(a.sessionId);
                      else if (a.projectId) openProject(a.projectId);
                    }}
                  >
                    {a.kind === 'attempt_failed' ? uiMessage(a.title) : a.title}
                  </button>
                  <small>
                    {a.projectId ? projectName.get(a.projectId) : ''}
                    {a.kind === 'session_stalled' && a.detail
                      ? ' ' + tr('{count} min without new records', { count: a.detail })
                      : a.detail && a.kind !== 'unassigned_active'
                        ? ' ' + uiMessage(a.detail)
                        : a.detail
                          ? ' ' + a.detail
                          : ''}
                    {a.at ? ' · ' + relativeTime(a.at) : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="surface monitor-projects" aria-label={tr('Project status')}>
          <div className="section-heading">
            <h2>
              {tr('Project status')} <span>{data.projects.length}</span>
            </h2>
          </div>
          {!data.projects.length ? (
            <Empty icon={<FolderGit2 />} title={tr('No registered projects')}>
              {tr('Import a local folder to group sessions whose working directory matches it.')}
            </Empty>
          ) : (
            <div className="monitor-project-list">
              {data.projects.map((p) => (
                <article key={p.projectId} className={projectId === p.projectId ? 'selected' : ''}>
                  <header>
                    <button className="text-button" onClick={() => openProject(p.projectId)}>
                      <b>{p.name}</b>
                    </button>
                    <Tone tone={healthTone[p.health]} label={tr(healthKey[p.health])} />
                  </header>
                  <div className="meter">
                    <i
                      style={{
                        width: `${p.tasks.total ? (p.tasks.completed / p.tasks.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <small>
                    {tr('{done}/{total} tasks completed', {
                      done: p.tasks.completed,
                      total: p.tasks.total,
                    })}{' '}
                    ·{' '}
                    {tr('{active} active / {total} sessions', {
                      active: p.sessions.active,
                      total: p.sessions.total,
                    })}
                    {p.runs.active ? ' · ' + tr('{count} runs', { count: p.runs.active }) : ''}
                    {p.alerts ? ' · ' + tr('{count} alerts', { count: p.alerts }) : ''}
                  </small>
                  <footer>
                    <small>{relativeTime(p.lastActivityAt)}</small>
                    <button
                      className="text-button"
                      onClick={() => {
                        setProjectId(projectId === p.projectId ? '' : p.projectId);
                        setFilter('all');
                      }}
                    >
                      {projectId === p.projectId ? tr('Show all sessions') : tr('Show sessions')}
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="surface monitor-sessions" aria-label={tr('Native sessions')}>
        <div className="section-heading">
          <h2>
            {tr('Native sessions')} <span>{sessions.length}</span>
          </h2>
          <div className="monitor-filters">
            <select
              aria-label={tr('Session filter')}
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
            >
              <option value="recent">{tr('Last 24 hours')}</option>
              <option value="active">{tr('Active now')}</option>
              <option value="open">{tr('Open in a process')}</option>
              <option value="attention">{tr('Needs attention')}</option>
              <option value="unassigned">{tr('Unassigned')}</option>
              <option value="all">{tr('All')}</option>
            </select>
            <select
              aria-label={tr('Tool')}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">{tr('All tools')}</option>
              <option value="codex">OpenAI Codex</option>
              <option value="claude">Claude Code</option>
            </select>
            <select
              aria-label={tr('Client')}
              value={client}
              onChange={(e) => setClient(e.target.value)}
            >
              <option value="all">{tr('All clients')}</option>
              {(Object.keys(clientKey) as SessionClient[]).map((c) => (
                <option key={c} value={c}>
                  {tr(clientKey[c])}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!sessions.length ? (
          <Empty icon={<MessagesSquare />} title={tr('No matching sessions')}>
            {tr('Change the filters, or start a session from your terminal or IDE.')}
          </Empty>
        ) : (
          <div className="monitor-table" role="table" aria-label={tr('Native sessions')}>
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={s.id === selected}
                projectName={projectName}
                onSelect={() => setSelected(s.id === selected ? '' : s.id)}
              />
            ))}
          </div>
        )}
        {data.truncated && (
          <p className="form-hint">{tr('Only the most recent sessions are listed.')}</p>
        )}
      </section>
      {current && (
        <SessionDetail
          key={current.id}
          session={current}
          projectName={projectName}
          close={() => setSelected('')}
        />
      )}
    </div>
  );
}

function SessionRow({
  session: s,
  selected,
  projectName,
  onSelect,
}: {
  session: MonitoredSession;
  selected: boolean;
  projectName: Map<string, string>;
  onSelect: () => void;
}) {
  return (
    <div role="row" className={`monitor-row ${selected ? 'selected' : ''} ${s.liveness}`}>
      <span role="cell" className="monitor-state">
        <span
          className={`connection-dot ${live(s) ? 'online' : ''}`}
          title={processText(s)}
          aria-label={processText(s)}
        />
        <Tone {...stateOf(s)} />
      </span>
      <span role="cell" className="monitor-title">
        <b>{s.title || s.providerSessionId}</b>
        {s.lastRequest && s.lastRequest !== s.title && <small>{s.lastRequest}</small>}
      </span>
      <span role="cell">
        {s.projectId ? (
          (projectName.get(s.projectId) ?? tr('Archived project'))
        ) : s.suggestedProjectId ? (
          <small>
            {tr('Subfolder of {name}', { name: projectName.get(s.suggestedProjectId) ?? '—' })}
          </small>
        ) : (
          <small title={s.cwd}>{tr('Unassigned')}</small>
        )}
        {s.association === 'managed' && <small>{tr('Workspace-managed')}</small>}
      </span>
      <span role="cell">
        {providerName(s.provider)}
        <small>
          {tr(clientKey[s.client])}
          {s.clientDetail ? ` · ${s.clientDetail}` : ''}
        </small>
      </span>
      <span role="cell">
        <time dateTime={s.modifiedAt} title={new Date(s.modifiedAt).toLocaleString()}>
          {relativeTime(s.modifiedAt)}
        </time>
      </span>
      <span role="cell">
        <button className="secondary small" aria-label={tr('Inspect session')} onClick={onSelect}>
          <Eye size={14} />
        </button>
      </span>
    </div>
  );
}

function SessionDetail({
  session: s,
  projectName,
  close,
}: {
  session: MonitoredSession;
  projectName: Map<string, string>;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const output = useQuery({
    queryKey: ['monitor-output', s.id],
    queryFn: () => api<NativeOutput>(`/monitor/sessions/${s.id}/output`),
    refetchInterval: live(s) ? 5000 : false,
  });
  const rows: [string, string | undefined][] = [
    [tr('Tool'), providerName(s.provider)],
    [tr('Client'), tr(clientKey[s.client]) + (s.clientDetail ? ` · ${s.clientDetail}` : '')],
    [tr('Turn state'), stateOf(s).label],
    [tr('Process'), processText(s)],
    [tr('Native session ID'), s.providerSessionId],
    [tr('Working directory'), s.cwd],
    [
      tr('Project'),
      s.projectId
        ? projectName.get(s.projectId)
        : s.suggestedProjectId
          ? tr('Subfolder of {name}', { name: projectName.get(s.suggestedProjectId) ?? '—' })
          : tr('Unassigned'),
    ],
    [tr('Parent session'), s.parentSessionId],
    [tr('Started'), s.startedAt && new Date(s.startedAt).toLocaleString()],
    [tr('Last write'), new Date(s.modifiedAt).toLocaleString()],
    [tr('Errors in recent records'), s.errors ? String(s.errors) : undefined],
  ];
  return (
    <section className="surface monitor-detail" aria-label={tr('Session details')}>
      <div className="section-heading">
        <h2>{s.title || s.providerSessionId}</h2>
        <button className="secondary small" onClick={close}>
          {tr('Close')}
        </button>
      </div>
      <dl>
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <div className="monitor-resume">
        <span>{tr('Continue in your own terminal')}</span>
        <code>{s.resumeCommand}</code>
        <button
          className="secondary small"
          onClick={() =>
            void navigator.clipboard?.writeText(s.resumeCommand).then(() => setCopied(true))
          }
        >
          <Copy size={14} /> {copied ? tr('Copied') : tr('Copy command')}
        </button>
      </div>
      <p className="form-hint">
        {tr(
          'Workspace does not run this command. Recent transcript is redacted and read-only; tool calls are requests, not proof of success.',
        )}
      </p>
      {output.isPending && <p>{tr('Loading transcript…')}</p>}
      {output.error && <p role="alert">{errorText(output.error.message)}</p>}
      {output.data && (
        <ol className="monitor-transcript">
          {output.data.entries.slice(-30).map((entry, index) => (
            <li key={index} className={entry.role}>
              <small>
                {entry.role === 'user' ? tr('User') : tr('Assistant')}
                {entry.timestamp ? ' · ' + new Date(entry.timestamp).toLocaleTimeString() : ''}
              </small>
              <pre>{entry.text}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

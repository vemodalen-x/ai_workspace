import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bell,
  BellOff,
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
  ProjectHealth,
  SessionClient,
} from '../../../packages/shared/monitoring.ts';
import {
  SessionDetail,
  SessionRow,
  Tone,
  clientKey,
  providerName,
  relativeTime,
} from './MonitorSessions.tsx';
import './monitor.css';

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
export const alertKey: Record<MonitorAlert['kind'], MessageKey> = {
  session_error: 'Session recorded an error',
  session_stalled: 'Turn in progress with no new records',
  session_aborted: 'Turn interrupted',
  session_ended: 'Process exited mid-turn',
  session_needs_answer: 'Waiting for your answer',
  run_orphaned: 'Managed run outcome unknown',
  run_failed: 'Managed run needs review',
  attempt_failed: 'Experiment attempt failed',
  approval_pending: 'Merge approval pending',
  result_stale: 'Result is outdated',
  source_degraded: 'History source incomplete',
  unassigned_active: 'Active session outside registered projects',
};
/** Shared with the sidebar badge so both read one cached overview. */
export const monitorOverviewQuery = {
  queryKey: ['monitor-overview'],
  queryFn: () => api<MonitorOverview>('/monitor/overview'),
};
export const alertCount = (data?: MonitorOverview) =>
  data?.alerts.filter((a) => a.severity !== 'info').length ?? 0;
const alertTitle = (a: MonitorAlert) =>
  a.kind === 'attempt_failed' ? uiMessage(a.title) : a.title;
/**
 * Shows a desktop notification for each warning or error alert that appears after the first
 * overview, while the page is hidden or another view is open. Nothing leaves the browser.
 */
export function useAlertNotifications(
  data: MonitorOverview | undefined,
  enabled: boolean,
  quiet: boolean,
) {
  const seen = useRef<Set<string>>(undefined);
  useEffect(() => {
    const alerts = data?.alerts.filter((a) => a.severity !== 'info');
    if (!alerts) return;
    const previous = seen.current;
    seen.current = new Set(alerts.map((a) => a.id));
    if (
      !previous ||
      !enabled ||
      quiet ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return;
    for (const a of alerts.filter((a) => !previous.has(a.id)).slice(0, 3))
      new Notification(tr(alertKey[a.kind]), { body: alertTitle(a), tag: a.id });
  }, [data, enabled, quiet]);
}
type Filter = 'all' | 'active' | 'open' | 'recent' | 'attention' | 'unassigned' | 'answer';

export function Monitor({
  search,
  clearSearch,
  nativeSessionId,
  openSession,
  openProject,
  registerFolder,
  notifications,
  setNotifications,
}: {
  search: string;
  clearSearch: () => void;
  nativeSessionId: string;
  openSession: (id: string) => void;
  openProject: (projectId: string) => void;
  /** Opens the project import form for a session folder; only writes the Workspace database. */
  registerFolder: (path: string) => void;
  notifications: boolean;
  setNotifications: (enabled: boolean) => void;
}) {
  useLocale();
  const [filter, setFilter] = useState<Filter>('recent');
  const [provider, setProvider] = useState('all');
  const [client, setClient] = useState('all');
  const [projectId, setProjectId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [notifyError, setNotifyError] = useState('');
  const queryClient = useQueryClient();
  const overview = useQuery({ ...monitorOverviewQuery, refetchInterval: 10000 });
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
  const matching = (data?.sessions ?? []).filter(
    (s) =>
      (provider === 'all' || s.provider === provider) &&
      (client === 'all' || s.client === client) &&
      (!projectId || s.projectId === projectId) &&
      (!query ||
        [
          s.title,
          s.lastRequest,
          s.cwd,
          s.providerSessionId,
          s.model,
          providerName(s.provider),
          tr(clientKey[s.client]),
          projectName.get(s.projectId ?? ''),
        ].some((value) => value?.toLowerCase().includes(query))),
  );
  const sessions = matching.filter(
    (s) =>
      filter === 'all' ||
      (filter === 'active' && s.liveness === 'active') ||
      (filter === 'open' && s.process === 'attached') ||
      (filter === 'recent' && (s.liveness !== 'dormant' || s.process === 'attached')) ||
      (filter === 'answer' && s.needsAnswer) ||
      (filter === 'attention' && attention.has(s.id)) ||
      (filter === 'unassigned' && s.association === 'unassigned'),
  );
  sessions.sort(
    (a, b) =>
      Number(b.needsAnswer) - Number(a.needsAnswer) ||
      Number(attention.has(b.id)) - Number(attention.has(a.id)) ||
      b.modifiedAt.localeCompare(a.modifiedAt),
  );
  const current = data?.sessions.find((s) => s.id === nativeSessionId);
  const selectedFrom = useRef<HTMLElement>(null);
  const sessionList = useRef<HTMLElement>(null);
  function inspect(id: string, trigger: HTMLElement) {
    selectedFrom.current = trigger;
    openSession(id);
  }
  function resetFilters() {
    setFilter('all');
    setProvider('all');
    setClient('all');
    setProjectId('');
    clearSearch();
  }
  function closeSession() {
    openSession('');
    if (selectedFrom.current?.isConnected) selectedFrom.current.focus();
    else sessionList.current?.focus();
  }
  if (overview.isPending) return <p className="monitor-loading">{tr('Loading monitor…')}</p>;
  if (overview.error && !data)
    return (
      <p role="alert" className="monitor-loading">
        {errorText(overview.error.message)}
      </p>
    );
  if (!data) return null;
  const filtersApplied =
    filter !== 'all' || provider !== 'all' || client !== 'all' || !!projectId || !!query;
  const waitingCount = matching.filter((s) => s.needsAnswer).length;
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
      label: tr('Turn finished'),
      value: data.totals.waiting,
      sub: tr('Turn finished in the last 24 hours'),
      icon: MessagesSquare,
      color: 'purple',
    },
    {
      label: tr('Alerts'),
      value: alertCount(data),
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
        <div className="button-group">
          <button
            className="secondary"
            aria-pressed={notifications}
            onClick={() => {
              setNotifyError('');
              if (notifications) return setNotifications(false);
              if (typeof Notification === 'undefined')
                return setNotifyError(tr('This browser does not support desktop notifications.'));
              void Notification.requestPermission().then((permission) =>
                permission === 'granted'
                  ? setNotifications(true)
                  : setNotifyError(tr('Desktop notifications are blocked for this page.')),
              );
            }}
          >
            {notifications ? <Bell size={15} /> : <BellOff size={15} />}{' '}
            {notifications ? tr('Notifications on') : tr('Notifications off')}
          </button>
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
      </div>
      {refreshError && <p role="alert">{errorText(refreshError)}</p>}
      {overview.error && (
        <p role="alert">
          {tr('Monitor refresh failed. Showing the last available results.')}{' '}
          {errorText(overview.error.message)}
        </p>
      )}
      {notifyError && <p role="alert">{notifyError}</p>}
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
      <div className="monitor-workbench">
        <section
          ref={sessionList}
          tabIndex={-1}
          className="surface monitor-sessions"
          aria-label={tr('Native sessions')}
        >
          <div className="section-heading">
            <h2>
              {tr('Native sessions')} <span>{sessions.length}</span>
            </h2>
            <div className="monitor-filters">
              <button
                className="secondary small"
                type="button"
                aria-pressed={filter === 'answer'}
                onClick={() => {
                  setFilter(filter === 'answer' ? 'recent' : 'answer');
                }}
              >
                {tr('Waiting for your answer')} <span>{waitingCount}</span>
              </button>
              <select
                aria-label={tr('Session filter')}
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
              >
                <option value="answer">{tr('Waiting for your answer')}</option>
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
              <select
                aria-label={tr('Project')}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">{tr('All projects')}</option>
                {data.projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {current && !sessions.some((session) => session.id === current.id) && (
            <div className="monitor-filter-notice">
              <span>{tr('The open session is outside the current filters.')}</span>
              <button className="text-button" type="button" onClick={resetFilters}>
                {tr('Show in session list')}
              </button>
            </div>
          )}
          {!sessions.length ? (
            <>
              <Empty icon={<MessagesSquare />} title={tr('No matching sessions')}>
                {tr('Change the filters, or start a session from your terminal or IDE.')}
              </Empty>
              {filtersApplied && (
                <button className="text-button" type="button" onClick={resetFilters}>
                  {tr('Clear session filters')}
                </button>
              )}
            </>
          ) : (
            <div className="monitor-table" role="table" aria-label={tr('Native sessions')}>
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={s.id === nativeSessionId}
                  projectName={projectName}
                  onSelect={(e) => inspect(s.id, e.currentTarget)}
                />
              ))}
            </div>
          )}
          {data.truncated && (
            <p className="form-hint">{tr('Only the most recent sessions are listed.')}</p>
          )}
        </section>
        {current ? (
          <SessionDetail
            key={current.id}
            session={current}
            projectName={projectName}
            close={closeSession}
            registerFolder={registerFolder}
          />
        ) : (
          <div className="surface monitor-selection-empty">
            {nativeSessionId ? (
              <>
                <Empty icon={<MessagesSquare />} title={tr('Session unavailable')}>
                  {tr(
                    'This session is outside the current index or its source is unavailable. Refresh to scan again.',
                  )}
                </Empty>
                <button className="secondary small" type="button" onClick={closeSession}>
                  {tr('Close')}
                </button>
              </>
            ) : (
              <Empty icon={<MessagesSquare />} title={tr('Select a session')}>
                {tr('Choose a session to see its progress and recent messages.')}
              </Empty>
            )}
          </div>
        )}
      </div>
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
                    onClick={(e) => {
                      if (a.sessionId) inspect(a.sessionId, e.currentTarget);
                      else if (a.projectId) openProject(a.projectId);
                    }}
                  >
                    {alertTitle(a)}
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
                        sessionList.current?.focus();
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
    </div>
  );
}

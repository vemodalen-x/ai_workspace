import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, FolderPlus } from 'lucide-react';
import { api } from './api.ts';
import { t as tr, errorText, type MessageKey } from './i18n.ts';
import type {
  MonitoredSession,
  SessionClient,
  SessionPhase,
} from '../../../packages/shared/monitoring.ts';
import type { NativeOutput } from '../../../packages/shared/native-history.ts';

export const providerName = (p: string) => (p === 'codex' ? 'OpenAI Codex' : 'Claude Code');
export const clientKey: Record<SessionClient, MessageKey> = {
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
  waiting: 'Turn finished',
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
const tokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);
const contextText = ({ context }: MonitoredSession) =>
  !context
    ? undefined
    : context.window
      ? tr('{used} of {window} tokens ({percent}%)', {
          used: tokens(context.tokens),
          window: tokens(context.window),
          percent: Math.min(100, Math.round((context.tokens / context.window) * 100)),
        })
      : tr('{used} tokens', { used: tokens(context.tokens) });
const progressText = (s: MonitoredSession) =>
  [
    s.activity &&
      tr('Running {tool}, started {time}', {
        tool: s.activity.tool,
        time: relativeTime(s.activity.since),
      }),
    s.plan &&
      tr('Plan {done}/{total}', { done: s.plan.done, total: s.plan.total }) +
        (s.plan.current ? ' · ' + s.plan.current : ''),
  ]
    .filter(Boolean)
    .join(' · ') || undefined;

export function relativeTime(iso: string | undefined, now = Date.now()) {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return tr('just now');
  if (seconds < 3600) return tr('{count} min ago', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return tr('{count} h ago', { count: Math.floor(seconds / 3600) });
  return tr('{count} d ago', { count: Math.floor(seconds / 86400) });
}

const stateOf = (s: MonitoredSession) =>
  s.needsAnswer
    ? { tone: 'pending', label: tr('Waiting for your answer') }
    : s.endedMidTurn
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

export function Tone({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {label}
    </span>
  );
}

export function SessionRow({
  session: s,
  selected,
  projectName,
  onSelect,
}: {
  session: MonitoredSession;
  selected: boolean;
  projectName: Map<string, string>;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
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
        <button
          type="button"
          className="text-button monitor-session-button"
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
        >
          {s.title || s.providerSessionId}
        </button>
        {s.lastRequest && s.lastRequest !== s.title && <small>{s.lastRequest}</small>}
        {progressText(s) && <small className="monitor-progress">{progressText(s)}</small>}
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
    </div>
  );
}

export function SessionDetail({
  session: s,
  projectName,
  close,
  registerFolder,
}: {
  session: MonitoredSession;
  projectName: Map<string, string>;
  close: () => void;
  registerFolder: (path: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showAll, setShowAll] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
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
    [tr('Progress'), progressText(s)],
    [tr('Model'), s.model],
    [tr('Context in use'), contextText(s)],
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
        <h2 ref={heading} tabIndex={-1}>
          {s.title || s.providerSessionId}
        </h2>
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
      {s.association === 'unassigned' && (
        <div className="monitor-register">
          <span>
            {tr(
              'This folder is not a registered project. Registering it only adds a Workspace record; the folder and the session are not changed.',
            )}
          </span>
          <button className="secondary small" onClick={() => registerFolder(s.cwd)}>
            <FolderPlus size={14} /> {tr('Register folder as project')}
          </button>
        </div>
      )}
      <div className="monitor-resume">
        <span>{tr('Continue in your own terminal')}</span>
        <code>{s.resumeCommand}</code>
        <button
          className="secondary small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(s.resumeCommand);
              setCopyState('copied');
            } catch {
              setCopyState('failed');
            }
          }}
        >
          <Copy size={14} /> {tr('Copy command')}
        </button>
      </div>
      <p className="form-hint">
        {tr(
          'Workspace does not run this command. Recent transcript is redacted and read-only; tool calls are requests, not proof of success.',
        )}
      </p>
      {copyState === 'copied' && <p role="status">{tr('Copied')}</p>}
      {copyState === 'failed' && (
        <p role="alert">{tr('Could not copy the command. Select and copy it manually.')}</p>
      )}
      {output.isPending && <p>{tr('Loading transcript…')}</p>}
      {output.error && <p role="alert">{errorText(output.error.message)}</p>}
      {output.data && (
        <>
          {!output.data.entries.length && <p>{tr('No displayable messages in this excerpt.')}</p>}
          {(output.data.truncated || output.data.skipped > 0) && (
            <p className="form-hint">{tr('Only a partial transcript is available.')}</p>
          )}
          {output.data.entries.length > 30 && (
            <button type="button" className="secondary small" onClick={() => setShowAll(!showAll)}>
              {showAll ? tr('Show latest 30 messages') : tr('Show earlier messages')}
            </button>
          )}
          <ol className="monitor-transcript">
            {(showAll ? output.data.entries : output.data.entries.slice(-30)).map(
              (entry, index) => (
                <li key={index} className={entry.role}>
                  <small>
                    {entry.role === 'user' ? tr('User') : tr('Assistant')}
                    {entry.timestamp ? ' · ' + new Date(entry.timestamp).toLocaleTimeString() : ''}
                  </small>
                  <pre>{entry.text}</pre>
                </li>
              ),
            )}
          </ol>
        </>
      )}
    </section>
  );
}

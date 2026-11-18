import { HistoryTaskTree } from './HistoryTaskTree.tsx';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { t, errorText, uiMessage } from './i18n.ts';
import type { NativeHistory, NativeOutput } from '../../../packages/shared/native-history.ts';
export function ProjectHistory({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState('');
  const [provider, setProvider] = useState('all');
  const history = useQuery({
    queryKey: ['local-history', projectId],
    queryFn: () => api<NativeHistory>(`/projects/${projectId}/local-history?refresh=true`),
    staleTime: 15000,
    refetchInterval: 15000,
  });
  const output = useQuery({
    queryKey: ['local-history-output', projectId, selected],
    queryFn: () => api<NativeOutput>(`/projects/${projectId}/local-history/${selected}`),
    enabled: !!selected,
    refetchInterval: 5000,
  });
  const sessions =
    history.data?.sessions.filter((s) => provider === 'all' || s.provider === provider) ?? [];
  return (
    <section className="surface project-history" aria-label={t('Local tool history')}>
      <div className="section-heading">
        <h2>{t('Local tool history')}</h2>
        <button
          type="button"
          className="secondary small"
          disabled={history.isFetching}
          onClick={() => void history.refetch()}
        >
          {t('Refresh')}
        </button>
      </div>
      <p className="form-hint">
        {t(
          'Read-only local history. Matching uses the exact canonical working directory; parent folders, subfolders and other worktrees are separate. Records do not become Workspace runs.',
        )}
      </p>
      {history.isPending && <p>{t('Loading local history…')}</p>}
      {history.error && <p role="alert">{errorText(history.error.message)}</p>}
      {history.data && (
        <>
          <div className="history-sources">
            {history.data.sources.map((source) => (
              <div key={source.path}>
                <strong>{source.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'}</strong> ·{' '}
                {uiMessage(source.state)} <code>{source.path}</code>
                {source.skipped > 0 && (
                  <small>
                    {t('{count} records could not be inspected. Results may be incomplete.', {
                      count: source.skipped,
                    })}
                  </small>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>{t('Available configuration and instructions')}</summary>
            <p>
              {t(
                'Settings show key names only to avoid exposing credentials. Instruction files are shown as text. This is a file inventory, not the tools’ effective configuration.',
              )}
            </p>
            {history.data.configs.map((config) => (
              <details key={config.path}>
                <summary>
                  <code>{config.path}</code> · {uiMessage(config.scope)} · {uiMessage(config.state)}
                </summary>
                {config.content !== undefined && <pre>{config.content}</pre>}
                {config.keys && (
                  <pre>{config.keys.join('\n') || t('No configuration keys found')}</pre>
                )}
                {config.truncated && <p>{t('Content truncated')}</p>}
              </details>
            ))}
          </details>
          <label>
            {t('Tool')}
            <select
              aria-label={t('Tool')}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setSelected('');
              }}
            >
              <option value="all">{t('All tools')}</option>
              <option value="codex">OpenAI Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <HistoryTaskTree projectId={projectId} provider={provider} onSession={setSelected} />
          {!sessions.length ? (
            <p className="form-hint">
              {t(
                'No matching readable sessions found. Check the source status above; records may use another tool home or working directory.',
              )}
            </p>
          ) : (
            <label>
              {t('Local sessions')}
              <select
                aria-label={t('Local sessions')}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">{t('Choose a session')}</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'} ·{' '}
                    {new Date(s.modifiedAt).toLocaleString()} · {s.title || s.providerSessionId}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected && (
            <div className="native-transcript" aria-label={t('Local session transcript')}>
              {output.isPending && <p>{t('Loading local history…')}</p>}
              {output.error && <p role="alert">{errorText(output.error.message)}</p>}
              {output.data && (
                <>
                  {!output.data.entries.length && (
                    <p>
                      {t('No readable user or assistant messages in the recent history window.')}
                    </p>
                  )}
                  {output.data.truncated && <p>{t('Content truncated')}</p>}
                  {output.data.skipped > 0 && (
                    <p>
                      {t('{count} records could not be inspected. Results may be incomplete.', {
                        count: output.data.skipped,
                      })}
                    </p>
                  )}
                  {output.data.entries.map((entry, i) => (
                    <article key={i}>
                      <strong>{uiMessage(entry.role)}</strong>
                      <pre>{entry.text}</pre>
                    </article>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

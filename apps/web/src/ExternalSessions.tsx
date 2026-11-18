import { t as tr, errorText, uiMessage } from './i18n.ts';
import React, { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import type {
  ExternalSession,
  ExternalSessionOutput,
} from '../../../packages/shared/external-sessions.ts';
import './external-sessions.css';

export function ExternalSessions({
  projectId,
  archived = false,
}: {
  projectId: string;
  archived?: boolean;
}) {
  const client = useQueryClient();
  const [sessionId, setSessionId] = useState('');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detachId, setDetachId] = useState('');
  const list = useQuery({
    queryKey: ['external-sessions', projectId],
    queryFn: () => api<ExternalSession[]>(`/projects/${projectId}/external-sessions`),
    refetchInterval: 4000,
  });
  const current = list.data?.find((s) => s.id === selected) ?? list.data?.[0];
  const output = useQuery({
    queryKey: ['external-session-output', current?.id],
    queryFn: () => api<ExternalSessionOutput>(`/external-sessions/${current!.id}/output`),
    enabled: !!current,
    refetchInterval: 4000,
    retry: false,
  });
  async function attach(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await api<ExternalSession>(
        `/projects/${projectId}/external-sessions`,
        'POST',
        { providerSessionId: sessionId.trim() },
      );
      setSelected(session.id);
      setSessionId('');
      await client.invalidateQueries({ queryKey: ['external-sessions', projectId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function detach(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/external-sessions/${id}`, 'DELETE');
      setDetachId('');
      await client.invalidateQueries({ queryKey: ['external-sessions', projectId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface external-sessions" aria-label={tr('Attached Claude sessions')}>
      <h2> {tr('Attached Claude sessions')} </h2>
      <p>
        {' '}
        {tr(
          'Read-only history and new messages, refreshed every 4 seconds. The original terminal owns execution. Attaching does not start an agent or import run/merge evidence.',
        )}{' '}
      </p>
      <form onSubmit={(e) => void attach(e)} className="external-attach-form">
        <label>
          {' '}
          {tr('Claude session ID')}{' '}
          <input
            aria-label={tr('Claude session ID')}
            placeholder="ac19a74b-8674-4eb6-903a-34a2ba5c3b0c"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            required
            disabled={archived || busy}
          />
        </label>
        <button className="secondary" disabled={archived || busy || !sessionId.trim()}>
          {' '}
          {tr('Attach session')}{' '}
        </button>
      </form>
      {(error || list.error) && <p role="alert">{errorText(error || list.error?.message || '')}</p>}
      {list.isLoading && <p> {tr('Loading attached sessions…')} </p>}
      {list.data?.length === 0 && <p> {tr('No attached sessions.')} </p>}
      {!!list.data?.length && (
        <>
          <label>
            {' '}
            {tr('Attached session')}{' '}
            <select
              aria-label={tr('Attached session')}
              value={current?.id ?? ''}
              onChange={(e) => {
                setSelected(e.target.value);
                setDetachId('');
              }}
            >
              {list.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.providerSessionId}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <>
              <p>
                {' '}
                {tr('Source directory:')} <code>{current.sourceCwd || tr('Unknown')}</code>{' '}
                {tr('. This session may have worked outside the selected project.')}{' '}
              </p>
              <div className="external-actions">
                <span> {tr('Read-only · Claude Code')} </span>
                {detachId === current.id ? (
                  <>
                    <span> {tr('Remove this link? Source history is preserved.')} </span>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void detach(current.id)}
                    >
                      {' '}
                      {tr('Confirm detach')}{' '}
                    </button>
                    <button className="secondary" onClick={() => setDetachId('')}>
                      {' '}
                      {tr('Cancel')}{' '}
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setDetachId(current.id)}
                  >
                    {' '}
                    {tr('Detach session')}{' '}
                  </button>
                )}
              </div>
            </>
          )}
          {output.isLoading && <p> {tr('Loading session history…')} </p>}
          {output.error && (
            <p role="alert">
              {' '}
              {tr('History unavailable:')} {errorText(output.error.message ?? '')}{' '}
              {tr('. The link is preserved; retrying every 4 seconds.')}{' '}
            </p>
          )}
          {output.data && (
            <>
              <p>
                {' '}
                {tr('Source updated')} {new Date(output.data.modifiedAt).toLocaleString()} ·{' '}
                {output.data.bytes.toLocaleString()}{' '}
                {tr('bytes. This is file activity, not proof the agent is running.')}{' '}
              </p>
              {(output.data.truncated || output.data.skipped > 0) && (
                <p role="status">
                  {' '}
                  {tr('Showing a bounded excerpt: at most the last 1 MiB / 200 messages.')}{' '}
                  {output.data.skipped}{' '}
                  {tr(
                    'malformed or oversized records skipped. Large message text is limited to 32,000 characters.',
                  )}{' '}
                </p>
              )}
              <div
                className="external-transcript"
                aria-label={tr('Session transcript')}
                aria-busy={output.isFetching}
              >
                {!output.data.entries.length && (
                  <p> {tr('No displayable messages in this excerpt.')} </p>
                )}
                {output.data.entries.map((entry, i) => (
                  <article key={i}>
                    <header>
                      <strong>{uiMessage(entry.role)}</strong>
                      {entry.timestamp && <time>{entry.timestamp}</time>}
                    </header>
                    <pre>{entry.text}</pre>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

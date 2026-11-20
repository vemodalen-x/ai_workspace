import { t as tr, errorText, uiMessage } from './i18n.ts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { ExecutionSummary as Summary } from '../../../packages/shared/execution-summary.ts';

export function ExecutionSummary({ taskId }: { taskId: string }) {
  const [history, setHistory] = useState(false);
  const query = useQuery({
    queryKey: ['execution-summary', taskId, history],
    queryFn: () => api<Summary>(`/tasks/${taskId}/summary?history=${history}`),
    refetchInterval: history ? false : 5000,
  });
  return (
    <div className="execution-summary">
      <div className="section-heading">
        <h3> {tr('Execution summary')} </h3>
        <button
          className="secondary small"
          disabled={query.isFetching}
          onClick={() => {
            if (!history) setHistory(true);
            else void query.refetch();
          }}
        >
          {' '}
          {tr('Load / refresh Codex · Claude history')}{' '}
        </button>
      </div>
      <small>
        {' '}
        {tr(
          'Extracted from execution evidence without paid models. Model claims do not prove validation passed; completion does not mean merged.',
        )}{' '}
      </small>
      {query.isPending && <p role="status"> {tr('Loading execution summary…')} </p>}
      {query.error && <p role="alert">{errorText(query.error.message ?? '')}</p>}
      {query.data && (
        <>
          <p>
            {query.data.runs.length} {tr('runs ·')}{' '}
            {query.data.runs.filter((run) => run.state === 'completed').length} {tr('completed ·')}{' '}
            {query.data.runs.filter((run) => run.state === 'failed').length}{' '}
            {tr('failed · updated')} {new Date(query.data.generatedAt).toLocaleString()}
          </p>
          {!query.data.runs.length && <p> {tr('No runs recorded.')} </p>}
          {query.data.runs.map((run) => (
            <details key={run.id} open={query.data.runs.length === 1}>
              <summary>
                {run.provider} · {run.model ?? tr('default')} · {uiMessage(run.state)} ·{' '}
                {run.id.slice(0, 8)}
              </summary>
              <p>
                {new Date(run.createdAt).toLocaleString()} · {run.evidenceCount}{' '}
                {tr('database evidence records')} {run.truncated ? tr('(latest 20,000 only)') : ''}
              </p>
              {run.error && (
                <p role="note">
                  {' '}
                  {tr('Execution error:')} {run.error}
                </p>
              )}
              <h4> {tr('Model statement (final excerpt)')} </h4>
              <pre>{run.conclusion || tr('No model statement recorded.')}</pre>
              <h4> {tr('Tool / command records')} </h4>
              <pre>{run.commands.join('\n') || tr('No records')}</pre>
              <h4> {tr('File records')} </h4>
              <pre>{run.files.join('\n') || tr('No records')}</pre>
            </details>
          ))}
          {query.data.histories.map((item) => (
            <details key={item.sessionId}>
              <summary>
                {item.provider} {tr('native history ·')} {uiMessage(item.status)} ·{' '}
                {item.sessionId.slice(0, 8)}
              </summary>
              <p>{uiMessage(item.detail)}</p>
              <p>{item.source}</p>
              <pre>{item.conclusion || tr('No extractable model statement')}</pre>
              <pre>{item.commands?.join('\n')}</pre>
              <pre>{item.files?.join('\n')}</pre>
            </details>
          ))}
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { t, errorText } from './i18n.ts';
import type {
  HistoryTaskTree as Tree,
  HistoryTaskNode,
} from '../../../packages/shared/native-history.ts';

export function HistoryTaskTree({
  projectId,
  provider,
  onSession,
}: {
  projectId: string;
  provider: string;
  onSession: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandAll, setExpandAll] = useState(false);
  const term = search.trim().toLowerCase();
  const query = useQuery({
    queryKey: ['history-task-tree', projectId],
    queryFn: () => api<Tree>(`/projects/${projectId}/history-task-tree?refresh=true`),
    refetchInterval: 15000,
  });
  const nodes =
    query.data?.nodes.filter((n) => provider === 'all' || n.provider === provider) ?? [];
  const children = new Map<string | null, HistoryTaskNode[]>();
  for (const node of nodes)
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const visible = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes)
    if (!term || `${node.title} ${node.description}`.toLowerCase().includes(term)) {
      let current: HistoryTaskNode | undefined = node;
      while (current && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
  function rows(parent: string | null) {
    return (children.get(parent) ?? [])
      .filter((n) => visible.has(n.id))
      .map((node) => {
        const nested = children.get(node.id)?.some((n) => visible.has(n.id));
        const open = !!term || (expanded[node.id] ?? expandAll);
        const body = (
          <>
            <span className="history-task-kind">
              {t(
                node.kind === 'session'
                  ? 'History session'
                  : node.kind === 'request'
                    ? 'User request'
                    : 'Recorded plan step',
              )}
            </span>
            {node.kind === 'session' && (
              <span className="history-task-kind">
                {node.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'}
              </span>
            )}
            <b title={node.description}>{node.title}</b>
            <span className="history-task-state">
              {t(
                node.state === 'completed'
                  ? 'Plan marked complete'
                  : node.state === 'in_progress'
                    ? 'Plan marked in progress'
                    : node.state === 'pending'
                      ? 'Plan marked pending'
                      : 'Historical record',
              )}
            </span>
          </>
        );
        return (
          <li key={node.id} aria-label={node.title}>
            {nested ? (
              <>
                <button
                  type="button"
                  className="history-disclosure"
                  aria-expanded={open}
                  aria-controls={`history-children-${node.id}`}
                  onClick={() => {
                    if (term) return;
                    setExpanded((current) => ({ ...current, [node.id]: !open }));
                  }}
                  aria-disabled={!!term}
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  {body}
                </button>
                <ul id={`history-children-${node.id}`} hidden={!open}>
                  {rows(node.id)}
                </ul>
              </>
            ) : (
              <div className="history-task-leaf">{body}</div>
            )}
            <button
              type="button"
              className="text-button"
              aria-label={t('View source for {title}', { title: node.title })}
              onClick={() => onSession(node.sessionId)}
            >
              {t('View source session')}
            </button>
          </li>
        );
      });
  }
  return (
    <section className="history-task-tree" aria-label={t('History task tree')}>
      <div className="section-heading">
        <h3>{t('History task tree')}</h3>
        <button
          type="button"
          className="secondary small"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('Refresh task tree')}
        </button>
      </div>
      <p className="form-hint">
        {t(
          'Automatically grouped as session → user request → explicit plan steps. Historical records are read-only; reported plan status is not verified execution evidence.',
        )}
      </p>
      <div className="button-group">
        <button
          type="button"
          className="secondary small"
          disabled={!!term}
          onClick={() => {
            setExpandAll(true);
            setExpanded({});
          }}
        >
          {t('Expand all')}
        </button>
        <button
          type="button"
          className="secondary small"
          disabled={!!term}
          onClick={() => {
            setExpandAll(false);
            setExpanded({});
          }}
        >
          {t('Collapse all')}
        </button>
      </div>
      <label>
        {t('Search history tasks')}
        <input
          aria-label={t('Search history tasks')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {search && (
        <button type="button" className="text-button" onClick={() => setSearch('')}>
          {t('Clear search')}
        </button>
      )}
      {term && (
        <p className="form-hint" role="status">
          {t('Matching branches are expanded while searching.')}
        </p>
      )}
      {query.isPending && <p>{t('Generating history task tree…')}</p>}
      {query.error && <p role="alert">{errorText(query.error.message)}</p>}
      {query.data?.truncated && (
        <p className="note">
          {t('History task tree is partial because a reading or display limit was reached.')}
        </p>
      )}
      {!!query.data?.unavailableSessions && (
        <p className="note">
          {t('{count} sessions could not be read for the task tree.', {
            count: query.data.unavailableSessions,
          })}
        </p>
      )}
      {!!query.data?.skipped && (
        <p className="form-hint">
          {t('{count} records could not be inspected. Results may be incomplete.', {
            count: query.data.skipped,
          })}
        </p>
      )}
      {query.data &&
        (nodes.length ? (
          <ul aria-label={t('History tasks')}>{rows(null)}</ul>
        ) : (
          <p>{t('No readable history tasks found for this project.')}</p>
        ))}
      {nodes.length > 0 && visible.size === 0 && <p>{t('No matching history tasks')}</p>}
    </section>
  );
}

import type { ReactNode } from 'react';
import { ChevronDown, Play, MoreHorizontal } from 'lucide-react';
import { Badge } from './Badge.tsx';
import type { Task, ComputeNode } from '../../../packages/shared/index.ts';
const short = (id: string) => id.slice(0, 8);
export function TaskTree({
  tasks,
  taskId,
  search,
  nodes,
  activeTaskIds,
  selectTask,
  onMove,
  onMenu,
  onLaunch,
}: {
  tasks: Task[];
  taskId: string;
  search: string;
  nodes: ComputeNode[];
  activeTaskIds: Set<string>;
  selectTask: (task: Task) => void;
  onMove: (id: string, parentId: string) => void;
  onMenu: (context: { task: Task; x: number; y: number }) => void;
  onLaunch: (task: Task) => void;
}) {
  function treeRows(parentId: string | null, depth = 0): ReactNode[] {
    return tasks
      .filter((t) => t.parentId === parentId)
      .flatMap((t) => {
        const matches =
          !search || `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase());
        const children = treeRows(t.id, depth + 1);
        return [
          matches ? (
            <div
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={taskId === t.id}
              tabIndex={0}
              key={t.id}
              className={`task-row ${taskId === t.id ? 'selected' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.dataTransfer.getData('text/task');
                if (id && id !== t.id) onMove(id, t.id);
              }}
              onClick={() => selectTask(t)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') selectTask(t);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu({
                  task: t,
                  x: Math.min(e.clientX, window.innerWidth - 205),
                  y: Math.min(e.clientY, window.innerHeight - 210),
                });
              }}
            >
              <div className="task-name" style={{ paddingLeft: 18 + depth * 24 }}>
                {tasks.some((c) => c.parentId === t.id) ? (
                  <ChevronDown size={13} />
                ) : (
                  <span className="tree-stem" />
                )}
                <span className={`task-dot ${t.state}`} />
                <div>
                  <b>{t.title}</b>
                  <small>
                    {t.integration
                      ? 'Integration workspace'
                      : `${t.dependencies.length} dependencies`}{' '}
                    · {short(t.id)}
                  </small>
                </div>
              </div>
              <Badge state={t.state} />
              <span className={`provider-label ${t.provider}`}>
                <span>{t.provider === 'codex' ? 'O' : t.provider === 'claude' ? '✳' : 'M'}</span>
                {t.provider === 'mock' ? 'Mock' : t.provider === 'claude' ? 'Claude Code' : 'Codex'}
              </span>
              <span className="node-label">
                {nodes.find((n) => n.id === t.nodeId)?.name ?? 'Unknown'}
              </span>
              <span className="row-actions">
                <button
                  aria-label={`Run ${t.title}`}
                  title="Start session"
                  disabled={activeTaskIds.has(t.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLaunch(t);
                  }}
                >
                  <Play size={14} />
                </button>
                <button
                  aria-label={`Actions for ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    onMenu({
                      task: t,
                      x: Math.min(rect.left, window.innerWidth - 205),
                      y: rect.bottom,
                    });
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              </span>
            </div>
          ) : null,
          ...children,
        ];
      });
  }
  return <>{treeRows(null)}</>;
}

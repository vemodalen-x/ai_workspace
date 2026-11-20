import { LanguageSelector } from './LanguageSelector.tsx';
import { t as tr } from './i18n.ts';
import type { ReactNode } from 'react';
import { ChevronRight, Search, Monitor, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Sidebar } from './Sidebar.tsx';
import type { Project, Task, Metrics } from '../../../packages/shared/index.ts';
import type { WorkspaceView } from './navigation.ts';
export function AppShell({
  view,
  setView,
  projects,
  project,
  tasks,
  taskId,
  runningCount,
  queuedCount,
  connected,
  onImport,
  onProject,
  selectTask,
  search,
  setSearch,
  inspector,
  setInspector,
  width,
  setWidth,
  metric,
  children,
  inspectorContent,
}: {
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  projects: Project[];
  project?: Project;
  tasks: Task[];
  taskId: string;
  runningCount: number;
  queuedCount: number;
  connected: boolean;
  onImport: () => void;
  onProject: (id: string) => void;
  selectTask: (task: Task) => void;
  search: string;
  setSearch: (value: string) => void;
  inspector: boolean;
  setInspector: (value: boolean) => void;
  width: number;
  setWidth: (value: number) => void;
  metric?: Metrics;
  children: ReactNode;
  inspectorContent: ReactNode;
}) {
  return (
    <>
      <a
        className="skip-link"
        href="#workspace-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('workspace-main')?.focus();
        }}
      >
        {' '}
        {tr('Skip to workspace')}{' '}
      </a>
      <Sidebar
        {...{
          view,
          setView,
          projects,
          project,
          tasks,
          taskId,
          runningCount,
          connected,
          onImport,
          onProject,
          selectTask,
        }}
      />
      <section className="shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span> {tr('Workspace')} </span>
            <ChevronRight size={13} />
            <b>
              {view === 'project'
                ? (project?.name ?? tr('Projects'))
                : (
                    {
                      focus: tr('Focus inbox'),
                      dashboard: tr('Overview'),
                      sessions: tr('Sessions'),
                      compute: tr('Compute nodes'),
                      experiments: tr('Experiments'),
                      activity: tr('Activity'),
                      settings: tr('Settings'),
                    } as const
                  )[view]}
            </b>
          </div>
          <div className="top-tools">
            <LanguageSelector />
            <label className="search">
              <Search size={14} />
              <input
                data-workspace-search
                aria-label={tr('Search workspace')}
                placeholder={tr('Search this view…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
            <span className="local-pill">
              <Monitor size={13} /> {tr('LOCAL')}{' '}
            </span>
            <button
              hidden={!['project', 'sessions'].includes(view)}
              className="icon-button"
              aria-label={tr('Toggle inspector')}
              onClick={() => setInspector(!inspector)}
            >
              {inspector ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
          </div>
        </header>
        <div className="body">
          <main id="workspace-main" tabIndex={-1}>
            {children}
          </main>
          {inspector && ['project', 'sessions'].includes(view) && (
            <>
              <div
                className="resize-handle"
                role="separator"
                aria-label={tr('Resize inspector')}
                aria-orientation="vertical"
                aria-valuenow={width}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setWidth(Math.min(480, width + 10));
                  if (e.key === 'ArrowRight') setWidth(Math.max(270, width - 10));
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  const start = e.clientX,
                    initial = width;
                  const move = (event: PointerEvent) =>
                    setWidth(Math.max(270, Math.min(480, initial + start - event.clientX)));
                  const stop = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', stop);
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', stop);
                }}
              />
              <aside className="inspector" style={{ width }}>
                {inspectorContent}
              </aside>
            </>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <span className={`connection-dot ${connected ? 'online' : ''}`} />
            {connected ? tr('Event stream connected') : tr('Reconnecting event stream')}
          </span>
          <span>
            {runningCount} {tr('running')} <i>·</i> {queuedCount} {tr('queued')} <i>·</i>{' '}
            {tr('SQLite persistent storage')}{' '}
          </span>
          <span>
            CPU {metric?.cpuPercent?.toFixed(0) ?? '—'}% <i>·</i> RAM{' '}
            {metric ? (metric.ramUsedMb / 1024).toFixed(1) : '—'} GB
          </span>
        </footer>
      </section>
    </>
  );
}

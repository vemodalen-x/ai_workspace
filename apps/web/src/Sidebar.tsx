import { t as tr } from './i18n.ts';
import {
  Layers,
  Shield,
  Zap,
  LayoutDashboard,
  FolderGit2,
  MessagesSquare,
  FlaskConical,
  Server,
  Activity,
  Plus,
  ChevronRight,
  Settings,
} from 'lucide-react';
import type { Project, Task } from '../../../packages/shared/index.ts';
import type { WorkspaceView } from './navigation.ts';
export function Sidebar({
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
}: {
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  projects: Project[];
  project?: Project;
  tasks: Task[];
  taskId: string;
  runningCount: number;
  connected: boolean;
  onImport: () => void;
  onProject: (id: string) => void;
  selectTask: (task: Task) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Layers size={21} />
        </div>
        <div>
          {' '}
          {tr('Agent Workspace')} <small> {tr('PERSONAL CONTROL CENTER')} </small>
        </div>
      </div>
      <div className="workspace-chip">
        <span className="avatar">W</span>
        <span>
          {' '}
          {tr('Personal workspace')} <small> {tr('Local-first · v0.8')} </small>
        </span>
        <Shield size={14} />
      </div>
      <nav aria-label={tr('Main navigation')}>
        {(
          [
            ['focus', Zap, tr('Focus inbox')],
            ['project', FolderGit2, tr('Projects')],
            ['experiments', FlaskConical, tr('Experiments')],
            ['compute', Server, tr('Compute nodes')],
            ['dashboard', LayoutDashboard, tr('Overview')],
            ['sessions', MessagesSquare, tr('All sessions')],
            ['activity', Activity, tr('Activity')],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            aria-label={label}
            title={label}
            className={view === id ? 'active' : ''}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setView(id)}
          >
            <Icon size={17} />
            {label}
            {id === 'sessions' && runningCount > 0 ? (
              <span className="nav-count">{runningCount}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="nav-section">
        <span> {tr('PROJECTS')} </span>
        <button aria-label={tr('Import project')} title={tr('Import project')} onClick={onImport}>
          <Plus size={16} />
        </button>
      </div>
      <div className="project-nav">
        {projects
          .filter((p) => !p.archived)
          .map((p) => (
            <div key={p.id}>
              <button
                className={project?.id === p.id && view === 'project' ? 'selected' : ''}
                onClick={() => {
                  onProject(p.id);
                }}
              >
                <span className="project-square">{p.name[0]?.toUpperCase()}</span>
                <span>{p.name}</span>
                <ChevronRight size={13} />
              </button>
              {project?.id === p.id &&
                view === 'project' &&
                tasks.slice(0, 7).map((t) => (
                  <button
                    className={`mini-task ${t.id === taskId ? 'selected' : ''}`}
                    key={t.id}
                    onClick={() => selectTask(t)}
                  >
                    <span className={`task-dot ${t.state}`} />
                    <span>{t.title}</span>
                  </button>
                ))}
            </div>
          ))}
        {!projects.length && (
          <p className="nav-empty">
            {' '}
            {tr('Import a Git repository')} <br /> {tr('to start your first project.')}{' '}
          </p>
        )}
      </div>
      <div className="sidebar-bottom">
        <div className="local-status">
          <span className={`connection-dot ${connected ? 'online' : ''}`} />
          <span>
            {connected ? tr('Control plane online') : tr('Reconnecting…')}
            <small> {tr('127.0.0.1 · local connection')} </small>
          </span>
        </div>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
          <Settings size={17} /> {tr('Settings & providers')}{' '}
        </button>
      </div>
    </aside>
  );
}

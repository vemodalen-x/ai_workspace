export const workspaceViews = [
  'monitor',
  'focus',
  'dashboard',
  'project',
  'sessions',
  'experiments',
  'compute',
  'activity',
  'settings',
] as const;
export type WorkspaceView = (typeof workspaceViews)[number];
export interface WorkspaceRoute {
  view: WorkspaceView;
  projectId: string;
  taskId: string;
  sessionId: string;
  nativeSessionId: string;
  treeMode: 'tree' | 'graph';
  tab: string;
  search: string;
}
export const defaultRoute: WorkspaceRoute = {
  view: 'focus',
  projectId: '',
  taskId: '',
  sessionId: '',
  nativeSessionId: '',
  treeMode: 'tree',
  tab: 'console',
  search: '',
};
const tabs = ['console', 'terminal', 'diff', 'history', 'artifacts'];
export function parseRoute(hash: string): WorkspaceRoute {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const text = (key: string, max = 200) => (params.get(key) ?? '').slice(0, max);
  const view = workspaceViews.includes(path as WorkspaceView) ? (path as WorkspaceView) : 'focus';
  const nativeSessionId = params.get('native') ?? '';
  return {
    view,
    projectId: text('project'),
    taskId: text('task'),
    sessionId: text('session'),
    nativeSessionId:
      view === 'monitor' && /^[a-f0-9]{64}$/.test(nativeSessionId) ? nativeSessionId : '',
    treeMode: text('tree') === 'graph' ? 'graph' : 'tree',
    tab: tabs.includes(text('tab')) ? text('tab') : 'console',
    search: text('q', 500),
  };
}
export function routeHash(route: WorkspaceRoute): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    project: route.projectId,
    task: route.taskId,
    session: route.sessionId,
    native: route.view === 'monitor' ? route.nativeSessionId : '',
    tree: route.treeMode === 'tree' ? '' : route.treeMode,
    tab: route.tab === 'console' ? '' : route.tab,
    q: route.search,
  })) {
    if (value) params.set(key, value);
  }
  return '#/' + route.view + (params.size ? '?' + params.toString() : '');
}

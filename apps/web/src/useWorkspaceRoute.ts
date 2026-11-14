import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRoute, routeHash, type WorkspaceRoute } from './navigation.ts';
import { readPreference, writePreference } from './preferences.ts';

export function useWorkspaceRoute() {
  const [route, setRoute] = useState(() =>
    parseRoute(
      window.location.hash || readPreference('aw.route', '#/' + readPreference('aw.view', 'focus')),
    ),
  );
  const current = useRef(route);
  const navigate = useCallback((patch: Partial<WorkspaceRoute>, replace = false) => {
    const next = parseRoute(routeHash({ ...current.current, ...patch }));
    const hash = routeHash(next);
    if (hash === routeHash(current.current)) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
    current.current = next;
    setRoute(next);
    writePreference('aw.route', hash);
  }, []);
  useEffect(() => {
    window.history.replaceState(null, '', routeHash(current.current));
    const restore = () => {
      const next = parseRoute(window.location.hash);
      current.current = next;
      setRoute(next);
      writePreference('aw.route', routeHash(next));
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, []);
  return { route, navigate };
}

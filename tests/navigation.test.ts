import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash, defaultRoute } from '../apps/web/src/navigation.ts';
import {
  comparisonWindow,
  validComparisonPreference,
} from '../apps/web/src/comparison-selection.ts';
import { runs } from '../examples/visual-review/data.ts';

test('workspace deep links preserve task/session/tab and escape search without accepting unknown views', () => {
  const route = {
    ...defaultRoute,
    view: 'sessions' as const,
    projectId: 'project',
    taskId: 'task',
    sessionId: 'session',
    tab: 'terminal',
    search: 'a & 中文 # / ?',
  };
  assert.deepEqual(parseRoute(routeHash(route)), route);
  assert.equal(parseRoute('#/unknown?tab=arbitrary&tree=anything').view, 'focus');
  assert.equal(parseRoute('#/monitor?q=codex').view, 'monitor');
  assert.equal(parseRoute('#/monitor?q=codex').search, 'codex');
  const native = 'f'.repeat(64);
  const monitored = parseRoute('#/monitor?native=' + native + '&q=claude');
  assert.equal(monitored.nativeSessionId, native);
  assert.equal(monitored.sessionId, '');
  assert.equal(routeHash(monitored), '#/monitor?native=' + native + '&q=claude');
  assert.equal(parseRoute('#/monitor?native=invalid').nativeSessionId, '');
  assert.equal(parseRoute('#/sessions?native=' + native + '&session=managed').nativeSessionId, '');
  assert.equal(parseRoute('#/sessions?tab=arbitrary').tab, 'console');
  assert.equal(parseRoute('#/project?tree=graph').treeMode, 'graph');
  assert.equal(parseRoute('#/experiments?q=' + 'x'.repeat(1000)).search.length, 500);
});
test('comparison window retains the pinned baseline beyond latest 20 without duplicating or changing source order', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    ...runs[0],
    id: String(i),
    createdAt: new Date(2026, 0, i + 1).toISOString(),
  }));
  const visible = comparisonWindow(history, '0');
  assert.equal(visible.length, 21);
  assert.equal(visible[0].id, '29');
  assert.equal(visible.at(-1)?.id, '0');
  assert.equal(history[0].id, '0');
  assert.equal(comparisonWindow(history, '29').length, 20);
  assert.equal(comparisonWindow(history, 'missing').length, 20);
});
test('persisted comparison selections reject malformed storage records', () => {
  assert.equal(validComparisonPreference({ metric: 'x', baselines: { x: 'run' } }), true);
  for (const value of [
    null,
    [],
    { metric: 4, baselines: {} },
    { metric: 'x', baselines: null },
    { metric: 'x', baselines: [] },
    { metric: 'x', baselines: { x: 4 } },
  ])
    assert.equal(validComparisonPreference(value), false);
});

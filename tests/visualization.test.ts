import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gpuCapacity } from '../packages/shared/gpu-capacity.ts';
import { metricChange, parameterChanges } from '../apps/web/src/experiment-comparison.ts';
import { reportedMetrics } from '../packages/shared/experiment-results.ts';
import { ExperimentCompare } from '../apps/web/src/ExperimentCompare.tsx';
import { HistoryChart } from '../apps/web/src/HistoryChart.tsx';
import { GpuCapacity } from '../apps/web/src/GpuCapacity.tsx';
import { fleet, runs, artifacts, exampleTime, history } from '../examples/visual-review/data.ts';

test('capacity board uses node-scoped UUID and index reservations and withholds stale headroom', () => {
  const gpu = fleet.metrics.train.gpus![0],
    reservation = fleet.reservations[0];
  const budgets = [
    reservation,
    { ...reservation, gpu: '0', vramMb: 1024, quarantined: true },
    { ...reservation, nodeId: 'other' },
  ];
  assert.deepEqual(gpuCapacity(gpu, budgets, 'train'), { reservedMiB: 9216, remainingMiB: 23552 });
  assert.equal(gpuCapacity({ ...gpu, usedMb: null }, budgets, 'train').remainingMiB, null);
  const markup = renderToStaticMarkup(
    createElement(GpuCapacity, {
      data: fleet,
      nodeIds: new Set(['train', 'eval']),
      asOf: exampleTime,
      inspect: () => {},
    }),
  );
  assert.ok(markup.indexOf('GPU-sample-b') < markup.indexOf('GPU-sample-a'));
  const offline = markup.slice(markup.indexOf('Evaluation server'));
  assert.match(offline, /Unavailable/);
});
test('comparison gates metric deltas by dataset, version, unit, project and step; raw readings remain visible', () => {
  const [candidate, mismatch, base] = runs,
    from = reportedMetrics(base, artifacts)[0],
    to = reportedMetrics(candidate, artifacts)[0];
  assert.ok(Math.abs(metricChange(base, candidate, from, to).delta! + 0.006) < 1e-12);
  assert.equal(metricChange(base, mismatch, from, to).delta, null);
  assert.equal(metricChange(base, candidate, from, { ...to, unit: 'percent' }).delta, null);
  assert.equal(metricChange(base, candidate, from, { ...to, step: 19 }).delta, null);
  assert.equal(metricChange(base, { ...candidate, projectId: 'other' }, from, to).delta, null);
  assert.equal(metricChange(base, candidate, from, undefined).delta, null);
  assert.deepEqual(parameterChanges(base, candidate), ['precision: "FP16" → "INT8"']);
  const html = renderToStaticMarkup(createElement(ExperimentCompare, { runs, artifacts }));
  assert.match(html, /Different dataset or version/);
  assert.match(html, /0.762/);
  assert.match(html, /-0.006/);
});
test('telemetry chart renders a single sample and breaks paths at missing readings or clock gaps', () => {
  const samples = history('train'),
    value = (m: (typeof samples)[number]['metrics']) => m.gpus?.[0].utilization ?? null;
  const render = (s: typeof samples) =>
    renderToStaticMarkup(
      createElement(HistoryChart, { samples: s, value, label: 'GPU utilization' }),
    );
  assert.match(render(samples.slice(0, 1)), /<circle /);
  const path = render(samples).match(/<path d="([^"]+)" fill="none"/)?.[1];
  assert.equal(path?.match(/M/g)?.length, 3);
});

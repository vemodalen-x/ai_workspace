import { useState } from 'react';
import { GpuCapacity } from '../../apps/web/src/GpuCapacity.tsx';
import { ExperimentCompare } from '../../apps/web/src/ExperimentCompare.tsx';
import { HistoryChart } from '../../apps/web/src/HistoryChart.tsx';
import { fleet, runs, artifacts, history, exampleTime } from './data.ts';
export function VisualReview() {
  const [view, setView] = useState('fleet'),
    [device, setDevice] = useState({ node: 'train', gpu: 'GPU-sample-a' });
  return (
    <main className="preview-shell">
      <header className="preview-header">
        <div>
          <small>AI Agent Workspace · v0.7</small>
          <h1>{view === 'fleet' ? 'Compute resources' : 'Experiments'}</h1>
        </div>
        <span className="preview-label">Offline design preview · sample data</span>
      </header>
      <nav aria-label="Preview view" className="view-switch">
        <button aria-pressed={view === 'fleet'} onClick={() => setView('fleet')}>
          Resource fleet
        </button>
        <button aria-pressed={view === 'experiments'} onClick={() => setView('experiments')}>
          Experiments
        </button>
      </nav>
      {view === 'fleet' ? (
        <>
          <GpuCapacity
            data={fleet}
            asOf={exampleTime}
            nodeIds={new Set(fleet.nodes.map((n) => n.id))}
            inspect={(node, gpu) => setDevice({ node, gpu })}
          />
          <section className="surface preview-history">
            <h2>
              {fleet.nodes.find((n) => n.id === device.node)?.name} · {device.gpu}
            </h2>
            <HistoryChart
              label="GPU utilization"
              samples={history(device.node)}
              value={(m) => m.gpus?.find((g) => g.id === device.gpu)?.utilization ?? null}
            />
          </section>
        </>
      ) : (
        <section className="surface fleet-node">
          <h1 className="preview-group">Quantization ablation</h1>
          <ExperimentCompare runs={runs} artifacts={artifacts} />
        </section>
      )}
    </main>
  );
}

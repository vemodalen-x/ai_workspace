import { usePreference } from './preferences.ts';
import { FlaskConical, Plus } from 'lucide-react';
import { ExperimentLedger } from './ExperimentLedger.tsx';
import type { Run, Snapshot } from '../../../packages/shared/index.ts';

export function ExperimentsPage({
  data,
  search,
  onRun,
  onCreate,
}: {
  data: Snapshot;
  search: string;
  onRun: (run: Run) => void;
  onCreate: (projectId?: string) => void;
}) {
  const [projectId, setProjectId] = usePreference('aw.experiments.project', '');
  const runs = data.runs.filter((r) => r.manifest?.taskSpec.experiment);
  const groups = new Set(
    runs.map((r) => JSON.stringify([r.projectId, r.manifest!.taskSpec.experiment!.group])),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <FlaskConical size={23} /> Experiments
          </h1>
          <p>
            Compare results against a saved baseline. Trace every result to its code and inputs.
          </p>
        </div>
        <button className="primary" onClick={() => onCreate(projectId || undefined)}>
          <Plus size={15} /> Create experiment task
        </button>
      </div>
      <div className="experiment-summary" aria-label="Experiment overview">
        <span>
          <b>{groups.size}</b> experiment groups
        </span>
        <span>
          <b>{runs.length}</b> recorded runs
        </span>
        <span>
          <b>{runs.filter((r) => ['starting', 'running'].includes(r.state)).length}</b> executing
        </span>
        <span>
          <b>{runs.filter((r) => r.state === 'failed' || r.state === 'orphaned').length}</b> failed
          or unknown
        </span>
      </div>
      <ExperimentLedger
        data={data}
        search={search}
        onRun={onRun}
        projectId={projectId}
        setProjectId={setProjectId}
      />
    </>
  );
}

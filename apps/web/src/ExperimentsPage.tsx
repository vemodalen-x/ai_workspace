import { t as tr } from './i18n.ts';
import { usePreference } from './preferences.ts';
import { FlaskConical, Plus } from 'lucide-react';
import { ExperimentLedger } from './ExperimentLedger.tsx';
import { CommandTrials } from './CommandTrials.tsx';
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
  const runs = data.runs.filter(
    (r) => r.manifest?.taskSpec.experiment && (!projectId || r.projectId === projectId),
  );
  const trials = data.trials.filter((t) => !projectId || t.projectId === projectId);
  const executions = [
    ...runs,
    ...data.attempts.filter((a) => !projectId || a.projectId === projectId),
  ];
  const groups = new Set(
    runs.map((r) => JSON.stringify([r.projectId, r.manifest!.taskSpec.experiment!.group])),
  );
  for (const t of trials) groups.add(JSON.stringify([t.projectId, t.experiment.group]));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <FlaskConical size={23} /> {tr('Experiments')}{' '}
          </h1>
          <p>
            {' '}
            {tr(
              'Compare results against a saved baseline. Trace every result to its code and inputs.',
            )}{' '}
          </p>
        </div>
        <button className="primary" onClick={() => onCreate(projectId || undefined)}>
          <Plus size={15} /> {tr('Create experiment task')}{' '}
        </button>
      </div>
      <div className="experiment-summary" aria-label={tr('Experiment overview')}>
        <span>
          <b>{groups.size}</b> {tr('experiment groups')}{' '}
        </span>
        <span>
          <b>{executions.length}</b> {tr('recorded executions')}{' '}
        </span>
        <span>
          <b>{executions.filter((r) => ['starting', 'running'].includes(r.state)).length}</b>{' '}
          {tr('executing')}{' '}
        </span>
        <span>
          <b>{executions.filter((r) => r.state === 'failed' || r.state === 'orphaned').length}</b>{' '}
          {tr('failed or unknown')}{' '}
        </span>
      </div>
      <div className="experiment-filters">
        <label>
          {' '}
          {tr('Project filter')}{' '}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value=""> {tr('All projects')} </option>
            {projectId && !data.projects.some((p) => p.id === projectId) && (
              <option value={projectId}> {tr('Unavailable project')} </option>
            )}
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <CommandTrials
        data={data}
        projectId={projectId}
        setProjectId={setProjectId}
        search={search}
      />
      <ExperimentLedger data={data} search={search} onRun={onRun} projectId={projectId} />
    </>
  );
}

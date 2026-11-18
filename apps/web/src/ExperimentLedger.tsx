import { t as tr } from './i18n.ts';
import { ExperimentCompare } from './ExperimentCompare.tsx';
import { reportedMetrics } from '../../../packages/shared/experiment-results.ts';
import { usePreference } from './preferences.ts';
import { Badge } from './Badge.tsx';
import type { Snapshot, Run } from '../../../packages/shared/index.ts';
import { RunResourceWindow } from './RunResourceWindow.tsx';
export function ExperimentLedger({
  data,
  search = '',
  onRun,
  projectId,
}: {
  data: Snapshot;
  search?: string;
  onRun?: (run: Run) => void;
  projectId: string;
}) {
  const [group, setGroup] = usePreference('aw.experiments.group', '');
  const runs = data.runs
    .filter((r) => r.manifest?.taskSpec.experiment)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groupKey = (r: (typeof runs)[number]) =>
    JSON.stringify([r.projectId, r.manifest!.taskSpec.experiment!.group]);
  const groups = new Map(
    runs.map((r) => [
      groupKey(r),
      (data.projects.find((p) => p.id === r.projectId)?.name ?? r.projectId) +
        ' / ' +
        r.manifest!.taskSpec.experiment!.group,
    ]),
  );
  const matchedGroups = new Map(
    [...groups].filter(([key, label]) => {
      const members = runs.filter((r) => groupKey(r) === key);
      return (
        (!projectId || members[0]?.projectId === projectId) &&
        (
          label +
          ' ' +
          members
            .map((r) =>
              [
                r.manifest?.taskSpec.title,
                r.manifest?.taskSpec.experiment?.dataset,
                r.manifest?.taskSpec.experiment?.datasetVersion,
              ].join(' '),
            )
            .join(' ')
        )
          .toLowerCase()
          .includes(search.toLowerCase())
      );
    }),
  );
  const selected = matchedGroups.has(group) ? group : matchedGroups.keys().next().value;
  const groupRuns = runs.filter((r) => groupKey(r) === selected);
  const visible = groupRuns.slice(0, 20);
  return (
    <section className="surface fleet-node experiment-ledger">
      <div className="visual-section-heading">
        <h2> {tr('Compare experiment runs')} </h2>
        <small>
          {runs.length} {tr('tracked')}{' '}
        </small>
      </div>
      {!runs.length ? (
        <p>
          {' '}
          {tr(
            'Enable “Track as an AI experiment” in a task. Each started Run keeps its own configuration.',
          )}{' '}
        </p>
      ) : (
        <>
          <div className="experiment-filters">
            <label>
              {' '}
              {tr('Experiment group')}{' '}
              <select value={selected ?? ''} onChange={(e) => setGroup(e.target.value)}>
                {!matchedGroups.size && <option value=""> {tr('No matching groups')} </option>}
                {[...matchedGroups].map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!matchedGroups.size ? (
            <p role="status">
              {' '}
              {tr(
                'No experiments match this project and search. Clear the project filter or workspace search to see other groups.',
              )}{' '}
            </p>
          ) : (
            <ExperimentCompare key={selected} runs={groupRuns} artifacts={data.artifacts} />
          )}
          <p className="comparison-note">
            {' '}
            {tr(
              'Run details show captured inputs. Session links open the conversation and its latest execution.',
            )}{' '}
          </p>
          <details className="run-ledger">
            <summary>
              {' '}
              {tr('Run details · latest')} {visible.length}
            </summary>
            <div className="fleet-table-scroll">
              <table className="fleet-table">
                <thead>
                  <tr>
                    <th> {tr('Run / task')} </th>
                    <th> {tr('Dataset / version')} </th>
                    <th> {tr('Seed')} </th>
                    <th> {tr('Reported metrics')} </th>
                    <th> {tr('Input commit')} </th>
                    <th> {tr('Server / device')} </th>
                    <th> {tr('Configuration & observations')} </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const m = r.manifest!,
                      e = m.taskSpec.experiment!;
                    const readings = reportedMetrics(r, data.artifacts);
                    return (
                      <tr key={r.id}>
                        <td>
                          {m.taskSpec.title}
                          <small>{r.id.slice(0, 8)}</small>
                          <Badge state={r.state} />
                          {onRun && (
                            <button className="text-button" onClick={() => onRun(r)}>
                              {' '}
                              {tr('Open session')}{' '}
                            </button>
                          )}
                        </td>
                        <td>
                          {e.dataset || tr('unset')}
                          <code>{e.datasetVersion || 'unversioned'}</code>
                        </td>
                        <td>{e.seed ?? tr('unset')}</td>
                        <td>
                          {readings.length
                            ? readings.map((p) => (
                                <div key={p.name + ':' + p.unit}>
                                  <b>{p.name}</b> {p.value} {p.unit}
                                  <small>
                                    {' '}
                                    {tr('step')} {p.step}
                                  </small>
                                </div>
                              ))
                            : tr('No verified report')}
                        </td>
                        <td>{m.baseCommit?.slice(0, 12) ?? tr('unavailable')}</td>
                        <td>
                          {data.nodes.find((n) => n.id === r.nodeId)?.name ?? r.nodeId}
                          <code>{m.environment.gpuId ?? tr('not recorded / none')}</code>
                        </td>
                        <td>
                          <RunResourceWindow run={r} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

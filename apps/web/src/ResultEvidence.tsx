import { RunResourceWindow } from './RunResourceWindow.tsx';
import type { Snapshot, Run } from '../../../packages/shared/index.ts';
import { evidence } from '../../../packages/shared/evidence.ts';
export function ResultEvidence({
  data,
  run,
  restart,
}: {
  data: Snapshot;
  run: Run;
  restart: () => void;
}) {
  const e = evidence(data, run);
  return (
    <div className="result-evidence" aria-label="Result evidence">
      <span>
        Execution <b>{run.state}</b>
      </span>
      <span>
        Validation command <b>{e.command.replace('_', ' ')}</b>
      </span>
      <span>
        Approved merge <b>{e.merged ? 'recorded' : 'not recorded'}</b>
      </span>
      <span>
        Input evidence <b>{e.freshness}</b>
      </span>
      {e.freshness !== 'current' && (
        <div className="evidence-warning" role="status">
          <p>{e.reasons.join(' ')}</p>
          {run.state === 'completed' && (
            <button className="secondary small" onClick={restart}>
              Re-run in new session
            </button>
          )}
        </div>
      )}
      <details className="execution-manifest">
        <summary>Execution inputs</summary>
        <pre>
          {run.manifest
            ? JSON.stringify(run.manifest, null, 2)
            : 'No manifest recorded for this historical run.'}
        </pre>
      </details>
      <RunResourceWindow run={run} />
      <small>
        Command success is evidence, not proof of every acceptance criterion. Commit:{' '}
        {e.commit?.slice(0, 12) ?? 'unavailable'}
      </small>
    </div>
  );
}

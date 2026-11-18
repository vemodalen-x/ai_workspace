import { t as tr, uiMessage } from './i18n.ts';
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
    <div className="result-evidence" aria-label={tr('Result evidence')}>
      <span>
        {' '}
        {tr('Execution')} <b>{uiMessage(run.state)}</b>
      </span>
      <span>
        {' '}
        {tr('Validation command')} <b>{uiMessage(e.command)}</b>
      </span>
      <span>
        {' '}
        {tr('Approved merge')} <b>{e.merged ? uiMessage('recorded') : tr('not recorded')}</b>
      </span>
      <span>
        {' '}
        {tr('Input evidence')} <b>{uiMessage(e.freshness)}</b>
      </span>
      {e.freshness !== 'current' && (
        <div className="evidence-warning" role="status">
          <p>{e.reasons.map(uiMessage).join(' ')}</p>
          {run.state === 'completed' && (
            <button className="secondary small" onClick={restart}>
              {' '}
              {tr('Re-run in new session')}{' '}
            </button>
          )}
        </div>
      )}
      <details className="execution-manifest">
        <summary> {tr('Execution inputs')} </summary>
        <pre>
          {run.manifest
            ? JSON.stringify(run.manifest, null, 2)
            : tr('No manifest recorded for this historical run.')}
        </pre>
      </details>
      <RunResourceWindow run={run} />
      <small>
        {' '}
        {tr('Command success is evidence, not proof of every acceptance criterion. Commit:')}{' '}
        {e.commit?.slice(0, 12) ?? tr('unavailable')}
      </small>
    </div>
  );
}

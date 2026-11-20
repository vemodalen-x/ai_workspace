import { t as tr, errorText, uiMessage } from './i18n.ts';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Square, Terminal } from 'lucide-react';
import { activeStates, type Snapshot } from '../../../packages/shared/index.ts';
import type { Trial } from '../../../packages/shared/trials.ts';
import { Badge } from './Badge.tsx';
import { TrialForm } from './TrialForm.tsx';
import { TrialOutput } from './TrialOutput.tsx';
import { ModalFrame } from './UiPrimitives.tsx';
import { api } from './api.ts';

export function CommandTrials({
  data,
  projectId,
  setProjectId,
  search,
}: {
  data: Snapshot;
  projectId: string;
  setProjectId: (id: string) => void;
  search: string;
}) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [confirm, setConfirm] = useState<{ trial: Trial; key: string; orphan?: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const trials = data.trials
    .filter(
      (t) =>
        (!projectId || projectId === t.projectId) &&
        [
          t.title,
          t.experiment.group,
          t.experiment.dataset,
          data.projects.find((p) => p.id === t.projectId)?.name,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .toReversed();
  const trial = trials.find((t) => t.id === selected) ?? trials[0];
  const project = data.projects.find((p) => p.id === trial?.projectId);
  const attempts = data.attempts.filter((a) => a.trialId === trial?.id).toReversed();
  const latest = attempts[0];
  const attempt = attempts.find((a) => a.id === attemptId) ?? latest;
  const refresh = () => client.invalidateQueries({ queryKey: ['snapshot'] });
  async function action(path: string, body: unknown) {
    setError('');
    setBusy(true);
    try {
      await api(path, 'POST', body);
      await refresh();
      setConfirm(undefined);
      setAttemptId('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface fleet-node trial-panel" aria-label={tr('Local command trials')}>
      <div className="visual-section-heading">
        <h2>
          <Terminal size={16} /> {tr('Command trials')}{' '}
        </h2>
        <button
          className="secondary"
          disabled={!data.projects.some((p) => !p.archived)}
          onClick={() => {
            setError('');
            setCreating(true);
          }}
        >
          <Plus size={15} /> {tr('New trial')}{' '}
        </button>
      </div>
      {creating && (
        <TrialForm
          data={data}
          projectId={projectId}
          close={() => setCreating(false)}
          saved={(t) => {
            if (projectId && projectId !== t.projectId) setProjectId(t.projectId);
            setSelected(t.id);
            setAttemptId('');
            setCreating(false);
            void refresh();
          }}
        />
      )}
      {trial ? (
        <>
          <div className="experiment-filters">
            <label>
              {' '}
              {tr('Command trial')}{' '}
              <select
                value={trial.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setAttemptId('');
                  setError('');
                }}
              >
                {trials.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} · {t.experiment.group}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {' '}
              {tr('Execution attempt')}{' '}
              <select
                value={attempt?.id ?? ''}
                disabled={!attempt}
                onChange={(e) => setAttemptId(e.target.value)}
              >
                {!attempt && <option value=""> {tr('No attempts')} </option>}
                {attempts.map((a, i) => (
                  <option key={a.id} value={a.id}>
                    #{attempts.length - i} · {uiMessage(a.state)} · {a.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="trial-command">
            <code>{JSON.stringify(trial.argv)}</code>
            <button
              className="primary"
              disabled={
                busy || project?.archived || Boolean(latest && activeStates.includes(latest.state))
              }
              onClick={() => {
                setError('');
                setConfirm({ trial, key: crypto.randomUUID() });
              }}
            >
              <Play size={14} />
              {latest ? tr('Retry trial') : tr('Run trial')}
            </button>
          </div>
          <details>
            <summary>
              {' '}
              {tr('Frozen inputs ·')} {trial.commit.slice(0, 10)} · {trial.allocation.gpu ?? 'CPU'}
            </summary>
            <pre>
              {JSON.stringify(
                {
                  project: project?.name,
                  commit: trial.commit,
                  experiment: trial.experiment,
                  allocation: trial.allocation,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {attempt && (
            <>
              <div className="trial-attempt">
                <Badge state={attempt.state} />
                {attempt.exitCode !== undefined && (
                  <span>
                    {' '}
                    {tr('Exit')} {attempt.exitCode}
                  </span>
                )}
                {attempt.reason && <span>{uiMessage(attempt.reason)}</span>}
                {['queued', 'starting', 'running'].includes(attempt.state) && (
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() => void action(`/attempts/${attempt.id}/cancel`, {})}
                  >
                    <Square size={12} /> {tr('Cancel attempt')}{' '}
                  </button>
                )}
                {attempt.state === 'orphaned' && (
                  <button
                    className="secondary small"
                    onClick={() => setConfirm({ trial, key: '', orphan: attempt.id })}
                  >
                    {' '}
                    {tr('Reconcile attempt')}{' '}
                  </button>
                )}
              </div>
              {attempt.workspace && (
                <details>
                  <summary> {tr('Attempt worktree')} </summary>
                  <code>{attempt.workspace}</code>
                </details>
              )}
              <TrialOutput
                key={attempt.id}
                attempt={attempt}
                trial={trial}
                attempts={data.attempts}
                trials={data.trials}
              />
            </>
          )}
        </>
      ) : (
        <p>
          {!data.projects.length
            ? tr('Import a Git project to create a trial.')
            : trials.length !== data.trials.length
              ? tr('No trials match this filter.')
              : tr('Create a trial to run a local command against a fixed Git commit.')}
        </p>
      )}
      {error && !confirm && <p role="alert">{errorText(error)}</p>}
      {confirm && (
        <ModalFrame
          title={confirm.orphan ? tr('Release trial reservation') : tr('Run local command')}
          close={() => {
            if (!busy) setConfirm(undefined);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (confirm.orphan
                ? action(`/attempts/${confirm.orphan}/reconcile`, { confirmedStopped: true })
                : action(`/trials/${confirm.trial.id}/attempts`, {
                    confirmed: true,
                    requestKey: confirm.key,
                  }));
            }}
          >
            <b>{confirm.trial.title}</b>
            <code>{JSON.stringify(confirm.trial.argv)}</code>
            <small>
              {' '}
              {tr('Commit')} {confirm.trial.commit}
            </small>
            <small>
              {' '}
              {tr('Local ·')} {confirm.trial.allocation.gpu ?? 'CPU'} ·{' '}
              {confirm.trial.allocation.cpu} CPU · {confirm.trial.allocation.ramMb} MiB RAM ·{' '}
              {confirm.trial.allocation.timeoutSec}s
            </small>
            {confirm.orphan && (
              <label>
                <input type="checkbox" required />{' '}
                {tr('I verified the local process has stopped.')}{' '}
              </label>
            )}
            {error && <p role="alert">{errorText(error)}</p>}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirm(undefined)}
                disabled={busy}
              >
                {' '}
                {tr('Cancel')}{' '}
              </button>
              <button className="primary" disabled={busy}>
                {confirm.orphan ? tr('Release reservation') : tr('Queue attempt')}
              </button>
            </div>
          </form>
        </ModalFrame>
      )}
    </section>
  );
}

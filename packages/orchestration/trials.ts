import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { git, type GitManager } from '../git-manager/index.ts';
import { runLocalCommand, redact } from '../agent-adapters/process.ts';
import { reserve } from '../resource-manager/index.ts';
import { now, activeStates, type Metrics } from '../shared/index.ts';
import { trialInput, type AttemptOutput, type TrialAttempt } from '../shared/trials.ts';
import type { ExperimentMetric } from '../shared/experiment-results.ts';
import type { Store } from './store.ts';
import { MetricOutput } from './metric-output.ts';
import { assertTransition } from './lifecycle.ts';

/** Both execution queues consume slots, including uncertain processes after a restart. */
export function occupiedSlots(store: Store, projectId: string) {
  const row = store.db
    .prepare(
      `SELECT
    (SELECT count(*) FROM runs WHERE json_extract(body,'$.projectId')=? AND
     json_extract(body,'$.state') IN ('starting','running','orphaned')) +
    (SELECT count(*) FROM attempts WHERE json_extract(body,'$.projectId')=? AND
     json_extract(body,'$.state') IN ('starting','running','orphaned')) AS n`,
    )
    .get(projectId, projectId)!;
  return Number(row.n);
}

const logLimit = 256 * 1024;
const sampleLimit = 5000;

export class TrialRunner {
  private handles = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private store: Store,
    private gitManager: GitManager,
  ) {
    for (const a of store.all('attempts')) {
      if (a.state !== 'starting' && a.state !== 'running') continue;
      store.tx(() => {
        this.update(a, 'orphaned', {
          reason: 'Controller restarted. Check the local process before releasing its reservation.',
        });
        const r = store.get('reservations', a.id);
        store.put('reservations', { ...r, quarantined: true });
      });
    }
  }

  async create(projectId: string, input: unknown) {
    const spec = trialInput.parse(input);
    const project = this.store.get('projects', projectId);
    if (project.archived) throw new Error('Project archived');
    const commit = await git(project.repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const id = randomUUID();
    const ref = `refs/ai-workspace/trials/${id}`;
    // A SHA in SQLite alone cannot keep an unreferenced Git object alive.
    await git(project.repoPath, ['update-ref', '--no-deref', ref, commit, '']);
    try {
      // The project can be archived or deleted while the Git process is running.
      if (this.store.get('projects', projectId).archived) throw new Error('Project archived');
      return this.store.put('trials', { ...spec, id, projectId, createdAt: now(), commit });
    } catch (error) {
      await git(project.repoPath, ['update-ref', '--no-deref', '-d', ref, commit]);
      throw error;
    }
  }

  enqueue(trialId: string, requestKey: string) {
    const trial = this.store.get('trials', trialId);
    return this.store.tx(() => {
      const all = this.store.all('attempts');
      const existing = all.find((a) => a.requestKey === requestKey);
      if (existing) {
        if (existing.trialId !== trialId) throw new Error('Request key belongs to another trial');
        return existing;
      }
      if (this.store.get('projects', trial.projectId).archived) throw new Error('Project archived');
      if (all.some((a) => a.trialId === trialId && activeStates.includes(a.state)))
        throw new Error('Trial already has an active attempt');
      const a = this.store.put('attempts', {
        id: randomUUID(),
        trialId,
        projectId: trial.projectId,
        requestKey,
        state: 'queued',
        createdAt: now(),
      });
      this.store.db.prepare('INSERT INTO trial_output(attempt_id) VALUES(?)').run(a.id);
      return a;
    });
  }

  private update(a: TrialAttempt, state: TrialAttempt['state'], patch: Partial<TrialAttempt> = {}) {
    assertTransition(a.state, state);
    this.store.put('attempts', { ...a, ...patch, state });
  }

  tick(metrics?: Metrics) {
    const pending = this.store.db
      .prepare(
        "SELECT body FROM attempts WHERE json_extract(body,'$.state')='queued' ORDER BY rowid",
      )
      .all();
    for (const row of pending) {
      const a: TrialAttempt = JSON.parse(row.body as string);
      const project = this.store.get('projects', a.projectId);
      const trial = this.store.get('trials', a.trialId);
      let reason = '';
      if (occupiedSlots(this.store, project.id) >= project.concurrency)
        reason = 'Waiting for a project slot';
      else {
        try {
          this.store.tx(() => {
            reserve(this.store, a.id, this.store.get('nodes', 'local'), trial.allocation, metrics);
            this.update(a, 'starting', {
              startedAt: now(),
              gpu: this.store.get('reservations', a.id).gpu,
              reason: undefined,
            });
          });
        } catch (error) {
          reason = (error as Error).message;
        }
      }
      if (reason) {
        if (reason !== a.reason) this.store.put('attempts', { ...a, reason });
        continue;
      }
      const controller = new AbortController();
      const done = this.execute(a.id, controller).finally(() => this.handles.delete(a.id));
      this.handles.set(a.id, { controller, done });
    }
  }

  private async execute(id: string, controller: AbortController) {
    const a = this.store.get('attempts', id);
    const trial = this.store.get('trials', a.trialId);
    const project = this.store.get('projects', trial.projectId);
    let state: TrialAttempt['state'] = 'failed',
      reason: string | undefined,
      exitCode: number | undefined;
    let omitted = 0,
      logSize = 0;
    const db = this.store.db;
    const save =
      db.prepare(`INSERT INTO trial_metrics(attempt_id,name,unit,step,value) VALUES(?,?,?,?,?)
      ON CONFLICT(attempt_id,name,unit,step) DO UPDATE SET value=excluded.value`);
    const known = new Set<string>();
    const output = new MetricOutput((m) => {
      const key = JSON.stringify([m.name, m.unit, m.step]);
      if (!known.has(key)) {
        if (known.size >= sampleLimit) {
          omitted++;
          return;
        }
        known.add(key);
      }
      save.run(id, m.name, m.unit, m.step, m.value);
    });
    const append = db.prepare(
      'UPDATE trial_output SET log=log||?, truncated=max(truncated,?) WHERE attempt_id=?',
    );
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const appendLog = (text: string) => {
      if (!text || logSize > logLimit) return;
      const bytes = Buffer.from(redact(text) as string);
      const kept = bytes.subarray(0, logLimit - logSize);
      append.run(kept.toString(), Number(bytes.length > kept.length), id);
      logSize += bytes.length;
    };
    const timeout = setTimeout(
      () => controller.abort('Attempt timed out'),
      trial.allocation.timeoutSec * 1000,
    );
    try {
      const work = await this.gitManager.create(project.repoPath, 'trial-' + id, trial.commit);
      this.update(a, 'running', { workspace: work.path });
      exitCode = await runLocalCommand(trial.argv, work.path, controller.signal, {
        env: {
          ...process.env,
          CUDA_VISIBLE_DEVICES: a.gpu ?? '',
          WORKSPACE_TRIAL_ID: trial.id,
          WORKSPACE_ATTEMPT_ID: id,
          WORKSPACE_EXPERIMENT: JSON.stringify(trial.experiment),
        },
        onPid: (pid) => this.store.put('attempts', { ...this.store.get('attempts', id), pid }),
        output: (chunk, stream) =>
          this.store.tx(() => {
            if (stream === 'stdout') output.push(chunk);
            appendLog(decoders[stream].write(chunk));
          }),
      });
      state = exitCode === 0 ? 'completed' : 'failed';
      if (exitCode !== 0) reason = `Command exited with code ${exitCode}`;
    } catch (error) {
      if (controller.signal.aborted) {
        reason = String(controller.signal.reason);
        state = reason === 'Attempt timed out' ? 'failed' : 'cancelled';
      } else reason = redact((error as Error).message) as string;
    } finally {
      clearTimeout(timeout);
      appendLog(decoders.stdout.end());
      appendLog(decoders.stderr.end());
      output.finish();
      this.store.tx(() => {
        db.prepare('UPDATE trial_output SET ignored=? WHERE attempt_id=?').run(
          output.ignored + omitted,
          id,
        );
        this.update(this.store.get('attempts', id), state, { endedAt: now(), reason, exitCode });
        this.store.delete('reservations', id);
      });
    }
  }

  cancel(id: string) {
    const a = this.store.get('attempts', id);
    if (a.state === 'queued')
      return this.update(a, 'cancelled', { endedAt: now(), reason: 'Cancelled' });
    const handle = this.handles.get(id);
    if (!handle) throw new Error('Attempt is not running');
    handle.controller.abort('Cancelled');
  }

  reconcile(id: string) {
    const a = this.store.get('attempts', id);
    if (a.state !== 'orphaned') throw new Error('Attempt is not orphaned');
    this.store.tx(() => {
      this.update(a, 'failed', {
        endedAt: now(),
        reason: 'Operator confirmed process stopped; outcome unknown',
      });
      this.store.delete('reservations', id);
    });
  }

  output(id: string): AttemptOutput {
    this.store.get('attempts', id);
    const row = this.store.db
      .prepare('SELECT log,truncated,ignored FROM trial_output WHERE attempt_id=?')
      .get(id)!;
    const metrics = this.store.db
      .prepare(
        'SELECT name,unit,step,value FROM trial_metrics WHERE attempt_id=? ORDER BY name,unit,step',
      )
      .all(id);
    return {
      log: String(row.log),
      logTruncated: Boolean(row.truncated),
      ignored: Number(row.ignored),
      metrics: metrics as unknown as ExperimentMetric[],
    };
  }

  async shutdown() {
    for (const h of this.handles.values()) h.controller.abort('Controller stopped');
    await Promise.allSettled([...this.handles.values()].map((h) => h.done));
  }
}

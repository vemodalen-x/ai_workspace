import { MetricOutput } from './metric-output.ts';
import type { ExperimentMetric } from '../shared/experiment-results.ts';
import { GitManager, git } from '../git-manager/index.ts';
import { validateCommand, ValidationExitError } from '../agent-adapters/process.ts';
import type { Workspace } from '../shared/index.ts';

/** Test the frozen candidate in its own worktree. Never reset/delete changed files. */
export async function verifyCandidate(input: {
  git: GitManager;
  repo: string;
  source: Workspace;
  runId: string;
  commit: string;
  argv: string[];
  gpu?: string | null;
  collectExperimentMetrics?: boolean;
  signal: AbortSignal;
  log: (text: string) => void;
}) {
  const id = `verify-${input.runId}`;
  const work = await input.git.create(input.repo, id, input.commit);
  const workspace: Workspace = {
    ...input.source,
    ...work,
    id,
    cleaned: false,
    integrationCommits: [],
  };
  const output = input.collectExperimentMetrics ? new MetricOutput() : undefined;
  const report = {
    metrics: undefined as ExperimentMetric[] | undefined,
    ignoredMetricLines: undefined as number | undefined,
    argv: input.argv,
    commit: input.commit,
    passed: false,
    exitCode: null as number | null,
    error: undefined as string | undefined,
    workspace: work.path,
    retained: true,
  };
  try {
    input.signal.throwIfAborted();
    await validateCommand(
      input.argv,
      work.path,
      input.signal,
      input.log,
      input.gpu,
      output && ((chunk) => output.push(chunk)),
    );
    report.exitCode = 0;
    if (
      (await git(work.path, ['rev-parse', 'HEAD'])) !== input.commit ||
      (await git(work.path, ['status', '--porcelain', '--untracked-files=no']))
    )
      throw new Error(
        'Validation modified tracked code or HEAD; evidence is not valid for the candidate commit',
      );
    report.passed = true;
    if (output) {
      report.metrics = output.finish();
      report.ignoredMetricLines = output.ignored;
    }
  } catch (e) {
    if (e instanceof ValidationExitError) report.exitCode = e.exitCode;
    report.error = (e as Error).message;
  } finally {
    try {
      await input.git.cleanup(input.repo, workspace);
      report.retained = false;
    } catch {
      /* Keep outputs or changed files and report the path for operator review. */
    }
  }
  return report;
}

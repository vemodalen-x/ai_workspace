import { createInterface } from 'node:readline';
import {
  realpath,
  mkdir,
  readFile,
  writeFile,
  open,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { adapters, providerStatuses } from '../../../packages/agent-adapters/index.ts';
import { redact } from '../../../packages/agent-adapters/process.ts';
import { GitManager, git, within } from '../../../packages/git-manager/index.ts';
import { collectMetrics } from '../../../packages/resource-manager/index.ts';
import { providerSchema, type Workspace } from '../../../packages/shared/index.ts';
const request = z.object({
  op: z.enum(['probe', 'metrics', 'run']),
  provider: providerSchema.optional(),
  controllerMonitors: z.boolean().default(false),
  sessionId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  repoPath: z.string().optional(),
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  prompt: z.string().max(40000).optional(),
  providerSessionId: z.string().optional(),
  model: z.string().max(200).optional(),
  gpu: z.string().max(100).nullable().optional(),
  timeoutSec: z.number().int().min(1).max(86400).default(3600),
});
const output = (data: unknown) => process.stdout.write(JSON.stringify(redact(data)) + '\n');
const abort = new AbortController();
process.stdin.on('end', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
const input = createInterface({ input: process.stdin });
let started = false;
input.on('line', (line) => {
  if (started) return;
  started = true;
  void run(line)
    .then(() => {
      process.stdout.write('', () => process.exit(0));
    })
    .catch((e) => {
      output({ kind: 'error', error: String(e.message ?? e) });
      process.stdout.write('', () => process.exit(1));
    });
});
async function run(line: string) {
  if (line.length > 65536) throw new Error('Request exceeds limit');
  const req = request.parse(JSON.parse(line));
  if (req.op === 'metrics') {
    output({ kind: 'metrics', metrics: await collectMetrics() });
    return;
  }
  if (req.op === 'probe') {
    output({ kind: 'probe', metrics: await collectMetrics(), providers: await providerStatuses() });
    return;
  }
  if (!req.repoPath || !req.sessionId || !req.runId || !req.provider || !req.baseCommit)
    throw new Error('Incomplete run request');
  if (!process.env.WORKER_REPO_ROOT)
    throw new Error('WORKER_REPO_ROOT must be configured in the SSH environment or wrapper');
  const allowed = await realpath(process.env.WORKER_REPO_ROOT),
    repo = await realpath(req.repoPath);
  if (repo !== allowed && !within(allowed, repo))
    throw new Error('Repository outside configured worker root');
  const root = resolve(process.env.WORKER_DATA_DIR ?? join(homedir(), '.ai-agent-worker'));
  await mkdir(join(root, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
  const gm = new GitManager(join(root, 'worktrees'));
  await gm.repository(repo);
  if ((await git(repo, ['rev-parse', 'HEAD'])) !== req.baseCommit)
    throw new Error(
      'Remote repository HEAD differs from recorded local base; synchronize repositories first',
    );
  const runPath = join(root, 'runs', `${req.runId}.json`);
  try {
    await writeFile(
      runPath,
      JSON.stringify({ state: 'running', sessionId: req.sessionId, pid: process.pid }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const previous = JSON.parse(await readFile(runPath, 'utf8'));
    if (previous.state === 'completed' && previous.sessionId === req.sessionId) {
      output({ kind: 'workspace', workspace: previous.workspace });
      output({ kind: 'complete', diff: previous.diff, replayed: true });
      return;
    }
    throw new Error(
      'Run ID already claimed; previous outcome must be reconciled. No duplicate execution.',
      { cause: e },
    );
  }
  const manifest = join(root, 'sessions', `${req.sessionId}.json`),
    lockPath = join(root, 'sessions', `${req.sessionId}.lock`);
  let lock: FileHandle | undefined;
  let collecting = false;
  const metricsTimer = req.controllerMonitors
    ? undefined
    : setInterval(() => {
        if (collecting) return;
        collecting = true;
        void collectMetrics()
          .then((metrics) => output({ kind: 'metrics', metrics }))
          .catch(() => {})
          .finally(() => {
            collecting = false;
          });
      }, 3000);
  const timeout = setTimeout(() => abort.abort(), req.timeoutSec * 1000);
  try {
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ runId: req.runId, pid: process.pid }));
    let w: Workspace;
    try {
      w = JSON.parse(await readFile(manifest, 'utf8'));
      await gm.assertOwned(repo, w);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const created = await gm.create(repo, req.sessionId, req.baseCommit);
      w = {
        id: req.sessionId,
        sessionId: req.sessionId,
        projectId: 'remote',
        ...created,
        nodeId: 'remote',
        cleaned: false,
        integrationCommits: [],
      };
      await writeFile(manifest, JSON.stringify(w), { mode: 0o600 });
    }
    output({ kind: 'workspace', workspace: w });
    await adapters[req.provider].run(
      {
        sessionId: req.sessionId,
        runId: req.runId,
        cwd: w.path,
        prompt: req.prompt ?? '',
        providerSessionId: req.providerSessionId,
        model: req.model,
        gpu: req.gpu,
        signal: abort.signal,
      },
      (event) => output({ kind: 'event', event }),
    );
    abort.signal.throwIfAborted();
    w.headCommit = await gm.snapshot(repo, w, `Agent run ${req.runId}`);
    await writeFile(manifest, JSON.stringify(w), { mode: 0o600 });
    const diff = await gm.diff(w);
    await writeFile(
      runPath,
      JSON.stringify({ state: 'completed', sessionId: req.sessionId, workspace: w, diff }),
      { mode: 0o600 },
    );
    output({ kind: 'workspace', workspace: w });
    output({ kind: 'complete', diff });
  } catch (e) {
    await writeFile(
      runPath,
      JSON.stringify({ state: 'failed', sessionId: req.sessionId, error: (e as Error).message }),
      { mode: 0o600 },
    );
    throw e;
  } finally {
    clearInterval(metricsTimer);
    clearTimeout(timeout);
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

import { TelemetryStore } from '../resource-manager/telemetry-store.ts';
import { NodeMonitor } from '../resource-manager/node-monitor.ts';
import { buildBriefing } from '../shared/assistant.ts';
import { executionBrief } from '../shared/context.ts';
import { freshness } from '../shared/evidence.ts';
import { captureManifest } from './manifest.ts';
import { assertTransition } from './lifecycle.ts';
import { verifyCandidate } from './verification.ts';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { Store } from './store.ts';
import { TrialRunner, occupiedSlots } from './trials.ts';
import { GitManager, git } from '../git-manager/index.ts';
import { adapters, providerStatuses, type AgentAdapter } from '../agent-adapters/index.ts';
import { redact } from '../agent-adapters/process.ts';
import { reserve, collectMetrics } from '../resource-manager/index.ts';
import { remoteRequest, runRemote, sshNodeInput } from './remote.ts';
import {
  activeStates,
  assertDag,
  assertTree,
  now,
  taskInput,
  type Approval,
  type Task,
  type Project,
  type Session,
  type Run,
  type Workspace,
  type ProviderStatus,
  type Metrics,
  type Snapshot,
  type AgentEvent,
} from '../shared/index.ts';

export class Orchestrator {
  store: Store;
  git: GitManager;
  trials: TrialRunner;
  providers: ProviderStatus[] = [];
  metrics: Record<string, Metrics> = {};
  telemetry: TelemetryStore;
  monitor: NodeMonitor;
  running = new Map<
    string,
    { abort: AbortController; promise: Promise<void>; intent?: 'paused' | 'cancelled' }
  >();
  adapters: typeof adapters;
  private ticking = false;
  private stopping = false;
  private lock: Promise<unknown> = Promise.resolve();
  constructor(
    public dataDir: string,
    options?: { adapters?: Record<'mock' | 'codex' | 'claude', AgentAdapter> },
  ) {
    this.store = new Store(join(dataDir, 'workspace.db'));
    this.telemetry = new TelemetryStore(this.store.db);
    this.monitor = new NodeMonitor((id, signal) => this.probeRemote(id, signal));
    this.git = new GitManager(join(dataDir, 'worktrees'));
    this.trials = new TrialRunner(this.store, this.git);
    this.adapters = options?.adapters ?? adapters;
    this.store.put('nodes', {
      id: 'local',
      name: os.hostname(),
      kind: 'local',
      status: 'online',
      cpu: os.cpus().length,
      ramMb: Math.floor(os.totalmem() / 1048576),
      lastSeen: now(),
    });
    for (const run of this.store.all('runs'))
      if (['starting', 'running'].includes(run.state)) {
        this.store.tx(() => {
          assertTransition(run.state, 'orphaned');
          run.state = 'orphaned';
          run.error =
            'Backend restarted during execution. Inspect the node and confirm the process stopped before reconciliation.';
          this.store.put('runs', run);
          const task = this.store.get('tasks', run.taskId);
          this.store.put('tasks', { ...task, state: 'paused', error: run.error });
          const reservation = this.store.all('reservations').find((r) => r.runId === run.id);
          if (reservation) this.store.put('reservations', { ...reservation, quarantined: true });
          this.emit({ type: 'RunOrphaned', data: { error: run.error } }, run);
        });
      }
    for (const node of this.store.all('nodes'))
      if (node.kind === 'ssh') this.store.put('nodes', { ...node, status: 'unknown' });
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }
  async refreshProviders() {
    this.providers = await providerStatuses();
    return this.providers;
  }
  async sample() {
    const metrics = await collectMetrics(
      [...this.running.keys()]
        .map((id) => this.store.get('runs', id).pid)
        .filter((p): p is number => p !== undefined),
    );
    if (!this.stopping) this.acceptMetrics('local', metrics);
    return metrics;
  }
  acceptMetrics(nodeId: string, metrics: unknown) {
    const node = this.store.get('nodes', nodeId);
    this.metrics[nodeId] = this.telemetry.record(nodeId, metrics);
    this.store.put('nodes', {
      ...node,
      status: 'online',
      telemetryError: undefined,
      lastSeen: this.metrics[nodeId].receivedAt,
    });
  }
  async sampleRemote() {
    await this.monitor.poll(
      this.store
        .all('nodes')
        .filter((n) => n.kind === 'ssh')
        .map((n) => n.id),
    );
  }
  snapshot(): Snapshot {
    const state = {
      ...Object.fromEntries(
        [
          'projects',
          'tasks',
          'sessions',
          'runs',
          'workspaces',
          'nodes',
          'approvals',
          'artifacts',
          'reservations',
          'trials',
          'attempts',
        ].map((k) => [k, this.store.all(k as 'projects')]),
      ),
      events: this.store.latestEvents(150),
      providers: this.providers,
      metrics: this.metrics,
    } as Snapshot;
    return { ...state, briefing: buildBriefing(state) };
  }
  emit(e: AgentEvent, run?: Run) {
    return this.store.event(
      redact(e) as AgentEvent,
      run ? { runId: run.id, sessionId: run.sessionId, projectId: run.projectId } : {},
    );
  }
  async createProject(input: { name: string; repoPath: string; concurrency: number }) {
    const repo = await this.git.repository(input.repoPath);
    if (this.store.all('projects').some((p) => p.repoPath === repo.path))
      throw new Error('Repository already imported');
    const p: Project = {
      id: randomUUID(),
      name: input.name,
      repoPath: repo.path,
      baseBranch: repo.branch,
      concurrency: input.concurrency,
      archived: false,
      createdAt: now(),
    };
    this.store.tx(() => {
      this.store.put('projects', p);
      this.store.event(
        { type: 'ProjectChanged', data: { action: 'created', name: p.name } },
        { projectId: p.id },
      );
    });
    return p;
  }
  updateProject(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'concurrency' | 'archived' | 'context'>>,
  ) {
    const p = this.store.get('projects', id);
    if (
      patch.archived &&
      [...this.store.all('runs'), ...this.store.all('attempts')].some(
        (r) => r.projectId === id && activeStates.includes(r.state),
      )
    )
      throw new Error('Stop or reconcile active runs before archiving');
    this.store.tx(() => {
      this.store.put('projects', {
        ...p,
        ...patch,
        contextRevision:
          (p.contextRevision ?? 1) +
          (patch.context !== undefined && patch.context !== (p.context ?? '') ? 1 : 0),
      });
      this.emit({ type: 'ProjectChanged', data: { id } });
    });
  }
  deleteProject(id: string) {
    const p = this.store.get('projects', id);
    if (
      this.store.all('tasks').some((t) => t.projectId === id) ||
      this.store.all('sessions').some((s) => s.projectId === id) ||
      this.store.all('trials').some((t) => t.projectId === id) ||
      this.store.all('externalSessions').some((s) => s.projectId === id)
    )
      throw new Error('Project has history; archive it to preserve records');
    this.store.tx(() => {
      this.store.delete('projects', p.id);
      this.emit({ type: 'ProjectChanged', data: { id, action: 'deleted' } });
    });
  }
  saveTask(projectId: string, input: unknown, id?: string) {
    const p = this.store.get('projects', projectId);
    if (p.archived) throw new Error('Project is archived');
    const data = taskInput.parse(input);
    this.store.get('nodes', data.nodeId);
    const old = id ? this.store.get('tasks', id) : undefined;
    if (old && old.projectId !== projectId) throw new Error('Wrong project');
    if (
      old &&
      this.store.all('runs').some((r) => r.taskId === id && activeStates.includes(r.state))
    )
      throw new Error('Cannot edit an active task');
    const task: Task = {
      ...data,
      id: id ?? randomUUID(),
      projectId,
      state: old?.state ?? 'draft',
      revision: old
        ? (old.revision ?? 1) +
          (JSON.stringify(taskInput.parse(old)) !== JSON.stringify(data) ? 1 : 0)
        : 1,
      createdAt: old?.createdAt ?? now(),
    };
    const tasks = this.store
      .all('tasks')
      .filter((t) => t.projectId === projectId && t.id !== id)
      .concat(task);
    assertDag(tasks);
    assertTree(tasks);
    if (new Set(task.dependencies).size !== task.dependencies.length)
      throw new Error('Duplicate dependency');
    this.store.tx(() => {
      this.store.put('tasks', task);
      this.store.event(
        { type: 'TaskChanged', data: { taskId: task.id, action: old ? 'updated' : 'created' } },
        { projectId },
      );
    });
    return task;
  }
  deleteTask(id: string) {
    this.store.get('tasks', id);
    if (this.store.all('sessions').some((s) => s.taskId === id))
      throw new Error('Task has session history and cannot be deleted');
    if (this.store.all('tasks').some((t) => t.parentId === id || t.dependencies.includes(id)))
      throw new Error('Move children and remove dependencies first');
    this.store.tx(() => {
      this.store.delete('tasks', id);
      this.emit({ type: 'TaskChanged', data: { taskId: id, action: 'deleted' } });
    });
  }
  enqueue(
    taskId: string,
    options: {
      requestKey: string;
      prompt?: string;
      sessionId?: string;
      model?: string;
      reasoningEffort?: Session['reasoningEffort'];
      allowReal?: boolean;
      allowValidation?: boolean;
    },
  ) {
    const existing = this.store.all('runs').find((r) => r.requestKey === options.requestKey);
    if (existing) {
      if (existing.taskId !== taskId) throw new Error('Idempotency key used for another task');
      return existing;
    }
    const task = this.store.get('tasks', taskId),
      project = this.store.get('projects', task.projectId);
    if (project.archived) throw new Error('Project archived');
    if (options.reasoningEffort && task.provider !== 'codex')
      throw new Error('Reasoning effort is supported only for Codex');
    if (this.store.all('runs').some((r) => r.taskId === taskId && activeStates.includes(r.state)))
      throw new Error('Task already has an active run');
    if (task.provider !== 'mock' && !options.allowReal)
      throw new Error('Explicit real-provider execution consent required');
    if (task.validationCommand?.length && !options.allowValidation)
      throw new Error('Explicit validation command execution consent required');
    if (task.nodeId !== 'local' && task.validationCommand?.length)
      throw new Error('Validation commands are local-only in this release');
    const node = this.store.get('nodes', task.nodeId);
    if (node.kind === 'ssh' && !task.remoteRepoPath)
      throw new Error('Remote repository path required');
    if (node.kind === 'local' && task.provider !== 'mock') {
      const status = this.providers.find((p) => p.id === task.provider);
      if (!status?.installed) throw new Error('Provider not installed');
      if (status.authenticated === false) throw new Error('Provider not logged in');
    }
    let session: Session;
    if (options.sessionId) {
      session = this.store.get('sessions', options.sessionId);
      if (
        session.taskId !== taskId ||
        session.provider !== task.provider ||
        session.nodeId !== task.nodeId ||
        session.closed
      )
        throw new Error('Session is closed or does not match task/provider/node');
      const w = this.store.get('workspaces', session.workspaceId);
      if (w.cleaned) throw new Error('Workspace was cleaned');
      if (
        (options.model !== undefined && options.model !== session.model) ||
        (options.reasoningEffort !== undefined &&
          options.reasoningEffort !== session.reasoningEffort)
      )
        throw new Error('Start a new session to change model or reasoning effort');
    } else {
      const id = randomUUID();
      session = {
        id,
        workspaceId: id,
        taskId,
        projectId: task.projectId,
        provider: task.provider,
        nodeId: task.nodeId,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        createdAt: now(),
        closed: false,
      };
    }
    const run: Run = {
      id: randomUUID(),
      sessionId: session.id,
      taskId,
      projectId: task.projectId,
      nodeId: task.nodeId,
      state: 'queued',
      prompt: options.prompt ?? `${task.description}\n\nAcceptance criteria: ${task.criteria}`,
      requestKey: options.requestKey,
      allocation: task.allocation,
      createdAt: now(),
    };
    this.store.tx(() => {
      this.store.put('sessions', session);
      this.store.put('runs', run);
      this.store.put('tasks', { ...task, state: 'queued', error: undefined });
      this.emit({ type: 'RunQueued', data: { task: task.title, provider: task.provider } }, run);
      this.emit({ type: 'MessageReceived', data: { text: run.prompt } }, run);
    });
    return run;
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const queued = this.store
        .all('runs')
        .filter((r) => r.state === 'queued')
        .sort(
          (a, b) =>
            this.store.get('tasks', b.taskId).priority -
              this.store.get('tasks', a.taskId).priority || a.createdAt.localeCompare(b.createdAt),
        );
      for (const run of queued) {
        const task = this.store.get('tasks', run.taskId),
          project = this.store.get('projects', run.projectId);
        const deps = task.dependencies.map((id) => this.store.get('tasks', id));
        if (deps.some((d) => d.state !== 'completed')) {
          if (task.state !== 'blocked')
            this.store.put('tasks', {
              ...task,
              state: 'blocked',
              error: deps.some((d) => ['failed', 'cancelled', 'paused'].includes(d.state))
                ? 'Dependency did not complete successfully'
                : 'Waiting for dependencies',
            });
          continue;
        }
        if (occupiedSlots(this.store, project.id) >= project.concurrency) continue;
        try {
          const manifest = captureManifest(this.snapshot(), task);
          assertTransition(run.state, 'starting');
          this.store.tx(() => {
            reserve(
              this.store,
              run.id,
              this.store.get('nodes', run.nodeId),
              run.allocation,
              this.metrics[run.nodeId],
            );
            manifest.environment.gpuId = this.store.get('reservations', run.id).gpu;
            this.store.put('runs', { ...run, manifest, state: 'starting', startedAt: now() });
            this.emit({ type: 'RunStarting', data: { taskRevision: manifest.taskRevision } }, run);
            this.store.put('tasks', { ...task, state: 'running', error: undefined });
          });
        } catch (e) {
          const error = (e as Error).message;
          this.store.put('tasks', { ...task, state: 'blocked', error });
          continue;
        }
        const abort = new AbortController();
        const handle = { abort, promise: Promise.resolve() };
        this.running.set(run.id, handle);
        handle.promise = this.execute(run.id, abort).finally(() => this.running.delete(run.id));
      }
      this.trials.tick(this.metrics.local);
    } finally {
      this.ticking = false;
    }
  }
  async prepareWorkspace(run: Run, session: Session): Promise<Workspace> {
    const project = this.store.get('projects', run.projectId),
      task = this.store.get('tasks', run.taskId);
    let workspace = this.store.all('workspaces').find((w) => w.sessionId === session.id);
    if (workspace) {
      if (workspace.cleaned) throw new Error('Workspace cleaned');
      if (
        task.integration &&
        JSON.stringify(workspace.integrationCommits) !==
          JSON.stringify(run.manifest?.dependencies.map((d) => d.commit) ?? [])
      )
        throw new Error(
          'Integration inputs changed; start a new session to validate the new dependency results',
        );
      if (session.nodeId === 'local') await this.git.assertOwned(project.repoPath, workspace);
      return workspace;
    }
    const baseCommit = await git(project.repoPath, ['rev-parse', 'HEAD']);
    workspace = {
      id: session.workspaceId,
      sessionId: session.id,
      projectId: project.id,
      path: session.nodeId === 'local' ? join(this.git.root, session.id) : `pending:${session.id}`,
      branch: `agent/${session.id}`,
      baseCommit,
      nodeId: session.nodeId,
      cleaned: false,
      integrationCommits: [],
    };
    if (session.nodeId === 'local') {
      Object.assign(workspace, await this.git.create(project.repoPath, session.id, baseCommit));
      this.store.put('workspaces', workspace);
      if (task.integration) {
        const commits = (run.manifest?.dependencies ?? []).map((ref) => {
          const dependency = this.store.get('runs', ref.runId);
          if (dependency.nodeId !== 'local')
            throw new Error('Dependency requires a local snapshot commit');
          return ref.commit;
        });
        await this.git.integrate(workspace, commits);
        workspace.integrationCommits = commits;
      }
    } else if (task.integration)
      throw new Error('Remote integration workspaces are not implemented');
    this.store.put('workspaces', workspace);
    return workspace;
  }
  private async execute(id: string, abort: AbortController) {
    let run = this.store.get('runs', id);
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    let remoteStarted = false;
    let providerStarted = false;
    try {
      const session = this.store.get('sessions', run.sessionId);
      const task = this.store.get('tasks', run.taskId);
      const w = await this.prepareWorkspace(run, session);
      abort.signal.throwIfAborted();
      assertTransition(run.state, 'running');
      const inputCommit =
        session.nodeId === 'local' ? await git(w.path, ['rev-parse', 'HEAD']) : w.baseCommit;
      run = {
        ...run,
        state: 'running',
        manifest: run.manifest ? { ...run.manifest, baseCommit: inputCommit } : undefined,
      };
      this.store.tx(() => {
        this.store.put('runs', run);
        this.emit(
          {
            type: 'SessionStarted',
            data: { provider: session.provider, branch: w.branch, workspace: w.path },
          },
          run,
        );
      });
      timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, run.allocation.timeoutSec * 1000);
      const emit = (e: AgentEvent) => {
        if (e.type === 'SessionStarted' && typeof e.data.providerSessionId === 'string')
          this.store.put('sessions', {
            ...this.store.get('sessions', session.id),
            providerSessionId: e.data.providerSessionId,
          });
        if (e.type === 'UsageUpdated')
          this.store.put('runs', { ...this.store.get('runs', id), usage: e.data });
        this.emit(e, run);
      };
      const brief = executionBrief(this.snapshot(), task, run);
      if (run.manifest) {
        run = {
          ...this.store.get('runs', id),
          manifest: {
            ...run.manifest,
            promptDigest: createHash('sha256').update(brief).digest('hex'),
          },
        };
        this.store.put('runs', run);
      }
      this.store.put('artifacts', {
        id: randomUUID(),
        runId: id,
        kind: 'context',
        name: 'execution-brief.txt',
        content: brief,
        createdAt: now(),
      });
      const config = {
        sessionId: session.id,
        runId: id,
        cwd: w.path,
        prompt: brief,
        providerSessionId: session.providerSessionId,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        gpu: this.store.get('reservations', id).gpu,
        signal: abort.signal,
        onPid: (pid: number) => this.store.put('runs', { ...this.store.get('runs', id), pid }),
      };
      let diff: string;
      abort.signal.throwIfAborted();
      if (session.nodeId === 'local') {
        providerStarted = true;
        await this.adapters[session.provider].run(config, emit);
        abort.signal.throwIfAborted();
        w.headCommit = await this.git.snapshot(
          this.store.get('projects', run.projectId).repoPath,
          w,
          `Agent run ${id}`,
        );
        this.store.put('workspaces', w);
        if (task.validationCommand?.length) {
          emit({
            type: 'ToolStarted',
            data: { name: 'Validation command', argv: task.validationCommand },
          });
          const report = await verifyCandidate({
            git: this.git,
            repo: this.store.get('projects', run.projectId).repoPath,
            source: w,
            runId: id,
            commit: w.headCommit,
            argv: task.validationCommand,
            gpu: config.gpu,
            collectExperimentMetrics: Boolean(run.manifest?.taskSpec.experiment),
            signal: abort.signal,
            log: (text) => emit({ type: 'Log', data: { text, source: 'validation' } }),
          });
          this.store.put('artifacts', {
            id: randomUUID(),
            runId: id,
            kind: 'validation',
            name: 'command-validation.json',
            content: JSON.stringify(report),
            createdAt: now(),
          });
          emit({
            type: 'ToolCompleted',
            data: { name: 'Validation command', passed: report.passed, exitCode: report.exitCode },
          });
          if (!report.passed) throw new Error(report.error ?? 'Validation failed');
        }
        diff = await this.git.diff(w);
      } else {
        remoteStarted = true;
        diff = await runRemote(
          this.store.get('nodes', run.nodeId),
          config,
          session.provider,
          task.remoteRepoPath,
          w.baseCommit,
          emit,
          (patch) => {
            this.store.put('workspaces', {
              ...w,
              path: patch.path ?? w.path,
              branch: patch.branch ?? w.branch,
              headCommit: patch.headCommit ?? w.headCommit,
            });
          },
          (metrics) => {
            try {
              this.acceptMetrics(run.nodeId, metrics);
            } catch {
              /* Telemetry failures do not terminate execution. */
            }
          },
        );
      }
      abort.signal.throwIfAborted();
      this.store.put('artifacts', {
        id: randomUUID(),
        runId: id,
        kind: 'diff',
        name: 'changes.diff',
        content: diff,
        createdAt: now(),
      });
      this.store.put('artifacts', {
        id: randomUUID(),
        runId: id,
        kind: 'summary',
        name: 'execution-summary.json',
        content: JSON.stringify({
          provider: session.provider,
          completed: true,
          integrationVerified: false,
          branch: w.branch,
        }),
        createdAt: now(),
      });
      this.store.put('runs', {
        ...this.store.get('runs', id),
        resultCommit: this.store.get('workspaces', session.workspaceId).headCommit,
      });
      this.finish(id, 'completed');
    } catch (e) {
      const reason = (e as Error).message;
      const sdkInterruption =
        providerStarted &&
        abort.signal.aborted &&
        this.store.get('sessions', run.sessionId).provider === 'codex';
      const state =
        remoteStarted || sdkInterruption
          ? 'orphaned'
          : timedOut
            ? 'failed'
            : abort.signal.aborted
              ? (this.running.get(id)?.intent ?? 'cancelled')
              : 'failed';
      this.finish(
        id,
        state,
        sdkInterruption
          ? 'Codex SDK interrupted. Verify its child processes stopped before reconciliation.'
          : timedOut
            ? 'Execution timeout'
            : reason,
      );
      if (remoteStarted) {
        const node = this.store.get('nodes', run.nodeId);
        this.store.put('nodes', { ...node, status: 'unknown' });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  finish(id: string, state: Run['state'], error?: string) {
    const run = this.store.get('runs', id),
      task = this.store.get('tasks', run.taskId);
    assertTransition(run.state, state);
    this.store.tx(() => {
      const endedAt = now();
      const telemetryAtFinish =
        run.telemetryAtFinish ??
        (run.startedAt &&
        run.state !== 'orphaned' &&
        state !== 'orphaned' &&
        run.manifest?.taskSpec.experiment
          ? this.telemetry.runWindow(
              run.nodeId,
              run.manifest.environment.gpuId ?? null,
              run.startedAt,
              endedAt,
            )
          : undefined);
      this.store.put('runs', { ...run, state, endedAt, telemetryAtFinish, error });
      this.store.put('tasks', {
        ...task,
        state: state === 'orphaned' ? 'paused' : (state as Task['state']),
        error,
      });
      if (state === 'orphaned') {
        const r = this.store.all('reservations').find((r) => r.id === id);
        if (r) this.store.put('reservations', { ...r, quarantined: true });
      } else this.store.delete('reservations', id);
      const type =
        state === 'completed'
          ? 'SessionCompleted'
          : state === 'failed'
            ? 'SessionFailed'
            : state === 'paused'
              ? 'RunPaused'
              : state === 'orphaned'
                ? 'RunOrphaned'
                : 'RunCancelled';
      this.emit({ type, data: { state, error: error ?? null } }, run);
    });
  }
  cancel(id: string, intent: 'paused' | 'cancelled' = 'cancelled') {
    const run = this.store.get('runs', id);
    if (run.state === 'orphaned') throw new Error('Reconcile the uncertain run first');
    if (run.state === 'queued') {
      this.finish(id, intent);
      return;
    }
    const handle = this.running.get(id);
    if (!handle) throw new Error('Run is not active');
    handle.intent = intent;
    handle.abort.abort();
  }
  reconcile(id: string, confirmed: boolean) {
    if (!confirmed) throw new Error('Explicit confirmation that the process stopped is required');
    const run = this.store.get('runs', id);
    if (run.state !== 'orphaned') throw new Error('Run is not orphaned');
    this.finish(
      id,
      'failed',
      'Operator reconciled: process stopped; outcome must be reviewed before retry',
    );
  }
  async addNode(input: unknown) {
    if (this.store.all('nodes').length >= 64) throw new Error('Maximum 64 monitored nodes');
    const n = sshNodeInput.parse(input);
    if (
      this.store
        .all('nodes')
        .some((node) => node.sshAlias?.toLowerCase() === n.sshAlias.toLowerCase())
    )
      throw new Error('SSH alias already registered; reuse its resource pool');
    const node = this.store.put('nodes', {
      ...n,
      id: randomUUID(),
      kind: 'ssh',
      status: 'unknown',
    });
    this.emit({ type: 'NodeChanged', data: { nodeId: node.id } });
    return node;
  }
  async probeNode(id: string) {
    const node = this.store.get('nodes', id);
    if (node.kind === 'local') return this.sample();
    return this.monitor.refresh(id);
  }
  private async probeRemote(id: string, signal: AbortSignal) {
    const node = this.store.get('nodes', id);
    let metrics: unknown;
    try {
      await remoteRequest(node, { op: 'metrics' }, signal, (line) => {
        if (line.kind === 'metrics') metrics = line.metrics;
      });
      if (!metrics)
        throw new Error('Worker did not return metrics; upgrade the remote worker to v0.4');
      this.acceptMetrics(id, metrics);
    } catch (e) {
      this.store.put('nodes', {
        ...this.store.get('nodes', id),
        status: 'offline',
        telemetryError: String(redact((e as Error).message)).slice(0, 500),
      });
      throw e;
    } finally {
      const current = this.store.get('nodes', id);
      if (current.status !== node.status)
        this.emit({ type: 'NodeChanged', data: { nodeId: id, status: current.status } });
    }
  }
  async diff(sessionId: string) {
    const s = this.store.get('sessions', sessionId);
    const w = this.store.get('workspaces', s.workspaceId);
    if (w.nodeId !== 'local' || w.cleaned) {
      const runs = this.store
        .all('runs')
        .filter((r) => r.sessionId === s.id)
        .map((r) => r.id);
      return (
        this.store
          .all('artifacts')
          .filter((a) => a.kind === 'diff' && runs.includes(a.runId))
          .at(-1)?.content ?? ''
      );
    }
    return this.git.diff(w);
  }
  assertIdle(sessionId: string) {
    if (
      this.store
        .all('runs')
        .some((r) => r.sessionId === sessionId && activeStates.includes(r.state))
    )
      throw new Error('Stop or reconcile active execution first');
  }
  assertCurrentResult(sessionId: string, source?: string) {
    const run = this.store
      .all('runs')
      .filter((r) => r.sessionId === sessionId)
      .at(-1);
    if (run && freshness(this.snapshot(), run).freshness === 'stale')
      throw new Error('Execution inputs changed; rerun before merge');
    if (!run || run.state !== 'completed') throw new Error('Merge requires a completed run');
    if (source && (run.manifest || run.resultCommit) && run.resultCommit !== source)
      throw new Error('Source differs from the completed run; rerun before merge');
  }
  async previewMerge(sessionId: string) {
    this.assertIdle(sessionId);
    this.assertCurrentResult(sessionId);
    const s = this.store.get('sessions', sessionId),
      w = this.store.get('workspaces', s.workspaceId),
      p = this.store.get('projects', s.projectId);
    if (w.nodeId !== 'local' || w.cleaned)
      throw new Error('Merge requires a local active worktree');
    await this.git.assertOwned(p.repoPath, w);
    if (await git(w.path, ['status', '--porcelain']))
      throw new Error('Workspace has unsnapshotted changes; review and snapshot before merge');
    const source = await git(w.path, ['rev-parse', 'HEAD']);
    this.assertCurrentResult(sessionId, source);
    const preview = await this.git.preview(p.repoPath, source);
    return this.store.tx(() => {
      const approval = this.store.put('approvals', {
        id: randomUUID(),
        kind: 'merge',
        sessionId,
        projectId: p.id,
        source,
        ...preview,
        state: 'pending',
        createdAt: now(),
      });
      this.store.event(
        {
          type: 'ApprovalRequested',
          data: { approvalId: approval.id, source, target: approval.target },
        },
        { sessionId, projectId: p.id },
      );
      return approval;
    });
  }
  private recordMerged(a: Approval) {
    this.store.tx(() => {
      this.store.put('approvals', { ...a, state: 'approved', error: undefined });
      this.store.event(
        {
          type: 'GitMerged',
          key: `merge:${a.id}`,
          data: { approvalId: a.id, commit: a.previewCommit },
        },
        { projectId: a.projectId, sessionId: a.sessionId },
      );
    });
  }
  async reconcileMerge(id: string) {
    const approval = this.store.get('approvals', id);
    if (approval.state !== 'applying') return approval;
    const repo = this.store.get('projects', approval.projectId).repoPath;
    const ref = await git(repo, ['rev-parse', '--verify', `refs/heads/${approval.targetBranch}`]);
    if (
      ref === approval.previewCommit ||
      (ref !== approval.target &&
        (await this.git.containsCommit(repo, ref, approval.previewCommit)))
    )
      this.recordMerged(approval);
    else if (ref === approval.target)
      this.store.put('approvals', {
        ...approval,
        state: 'pending',
        error: 'Target is at the original commit. Review again before applying.',
      });
    else
      this.store.put('approvals', {
        ...approval,
        state: 'superseded',
        error: 'Target moved independently. Inspect Git history and create a new preview.',
      });
    return this.store.get('approvals', id);
  }
  async recoverMerges() {
    for (const a of this.store.all('approvals').filter((a) => a.state === 'applying')) {
      try {
        await this.reconcileMerge(a.id);
      } catch {
        this.store.put('approvals', {
          ...a,
          error: 'Merge outcome unknown. Restore repository access and check again.',
        });
      }
    }
  }
  async decideApproval(id: string, approved: boolean) {
    const a = this.store.get('approvals', id);
    if (a.state !== 'pending')
      throw new Error('Approval already resolved or requires reconciliation');
    if (!approved) {
      this.store.put('approvals', { ...a, state: 'rejected' });
      return;
    }
    this.assertIdle(a.sessionId);
    this.assertCurrentResult(a.sessionId, a.source);
    const s = this.store.get('sessions', a.sessionId),
      w = this.store.get('workspaces', s.workspaceId);
    const repo = this.store.get('projects', a.projectId).repoPath;
    this.store.put('approvals', { ...a, state: 'applying', error: undefined });
    try {
      await this.git.merge(repo, a, w.branch);
    } catch (e) {
      try {
        await this.reconcileMerge(id);
      } catch {
        /* Leave durable intent for a later ref check. */
      }
      throw e;
    }
    this.recordMerged(a);
  }
  async cleanup(sessionId: string) {
    this.assertIdle(sessionId);
    const s = this.store.get('sessions', sessionId),
      w = this.store.get('workspaces', s.workspaceId);
    if (w.nodeId !== 'local')
      throw new Error('Remote cleanup must be performed on the worker after reconciliation');
    await this.git.cleanup(this.store.get('projects', s.projectId).repoPath, w);
    this.store.put('workspaces', { ...w, cleaned: true });
    this.store.put('sessions', { ...s, closed: true });
    this.emit({
      type: 'TaskChanged',
      data: { sessionId, action: 'workspace cleaned; branch retained' },
    });
  }
  async shutdown() {
    this.stopping = true;
    await this.monitor.stop();
    for (const h of this.running.values()) {
      h.intent = 'paused';
      h.abort.abort();
    }
    await Promise.allSettled([...this.running.values()].map((h) => h.promise));
    await this.trials.shutdown();
    this.store.close();
  }
  workspaceExists(sessionId: string) {
    return existsSync(join(this.git.root, sessionId));
  }
}

import { z } from 'zod';
import type { Briefing } from './assistant.ts';
import type { Trial, TrialAttempt } from './trials.ts';
import type { RunTelemetry, metricsSchema } from './telemetry.ts';

export const providerSchema = z.enum(['mock', 'codex', 'claude']);
export type Provider = z.infer<typeof providerSchema>;
export const taskStates = [
  'draft',
  'queued',
  'blocked',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskState = (typeof taskStates)[number];
export type RunState =
  'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'orphaned';
export const activeStates: RunState[] = ['queued', 'starting', 'running', 'orphaned'];
export const allocationSchema = z.object({
  cpu: z.number().positive().max(1024).default(1),
  ramMb: z.number().int().positive().max(1048576).default(512),
  gpu: z.string().max(100).nullable().default(null),
  vramMb: z.number().int().nonnegative().default(0),
  timeoutSec: z.number().int().min(1).max(86400).default(600),
});
export type Allocation = z.infer<typeof allocationSchema>;
export const experimentSchema = z.object({
  group: z.string().trim().min(1).max(120),
  dataset: z.string().max(500).default(''),
  datasetVersion: z.string().max(200).default(''),
  seed: z.number().int().nonnegative().max(4294967295).nullable().default(null),
  parameters: z
    .record(
      z.string().min(1).max(100),
      z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
    )
    .refine((p) => Object.keys(p).length <= 100)
    .default({}),
});
export const taskInput = z.object({
  experiment: experimentSchema
    .refine((v) => JSON.stringify(v).length <= 6000, 'Experiment metadata exceeds 6000 characters')
    .nullish(),
  title: z.string().trim().min(1).max(180),
  description: z.string().max(40000).default(''),
  criteria: z.string().max(10000).default(''),
  parentId: z.string().nullable().default(null),
  dependencies: z.array(z.string()).max(200).default([]),
  provider: providerSchema.default('mock'),
  nodeId: z.string().default('local'),
  priority: z.number().int().min(0).max(100).default(50),
  allocation: allocationSchema.default({
    cpu: 1,
    ramMb: 512,
    gpu: null,
    vramMb: 0,
    timeoutSec: 600,
  }),
  integration: z.boolean().default(false),
  remoteRepoPath: z.string().max(4096).default(''),
  validationCommand: z.array(z.string().min(1).max(4000)).max(100).default([]),
});
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  context?: string;
  contextRevision?: number;
  concurrency: number;
  archived: boolean;
  createdAt: string;
}
export interface Task extends z.infer<typeof taskInput> {
  revision?: number;
  id: string;
  projectId: string;
  state: TaskState;
  createdAt: string;
  error?: string;
}
export interface Session {
  id: string;
  taskId: string;
  projectId: string;
  provider: Provider;
  nodeId: string;
  workspaceId: string;
  providerSessionId?: string;
  model?: string;
  createdAt: string;
  closed: boolean;
}
export interface Workspace {
  id: string;
  sessionId: string;
  projectId: string;
  path: string;
  branch: string;
  baseCommit: string;
  headCommit?: string;
  nodeId: string;
  cleaned: boolean;
  integrationCommits: string[];
}
export interface RunManifest {
  version: 1;
  taskRevision: number;
  contextRevision: number;
  projectContext: string;
  taskSpec: z.infer<typeof taskInput>;
  dependencies: { taskId: string; runId: string; commit: string }[];
  baseCommit?: string;
  promptDigest?: string;
  providerVersion: string | null;
  environment: {
    nodeId: string;
    platform: string | null;
    runtime: string | null;
    gpuId?: string | null;
  };
}
export interface Run {
  id: string;
  sessionId: string;
  taskId: string;
  projectId: string;
  nodeId: string;
  state: RunState;
  prompt: string;
  requestKey: string;
  resultCommit?: string;
  manifest?: RunManifest;
  allocation: Allocation;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  telemetryAtFinish?: RunTelemetry;
  error?: string;
  usage?: Record<string, unknown>;
  pid?: number;
}
export interface ComputeNode {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  status: 'online' | 'offline' | 'unknown';
  cpu: number;
  ramMb: number;
  sshAlias?: string;
  workerPath?: string;
  lastSeen?: string;
  telemetryError?: string;
}
export interface Reservation {
  id: string;
  runId: string;
  nodeId: string;
  cpu: number;
  ramMb: number;
  gpu: string | null;
  vramMb: number;
  quarantined: boolean;
}
export interface Approval {
  id: string;
  kind: 'merge';
  sessionId: string;
  projectId: string;
  source: string;
  target: string;
  targetBranch: string;
  previewCommit: string;
  state: 'pending' | 'applying' | 'approved' | 'rejected' | 'superseded';
  createdAt: string;
  error?: string;
}
export interface Artifact {
  id: string;
  runId: string;
  kind: 'diff' | 'summary' | 'validation' | 'context';
  name: string;
  content: string;
  createdAt: string;
}
export type EventType =
  | 'SessionStarted'
  | 'MessageDelta'
  | 'MessageReceived'
  | 'ToolStarted'
  | 'ToolCompleted'
  | 'ApprovalRequested'
  | 'FileChanged'
  | 'UsageUpdated'
  | 'SessionCompleted'
  | 'SessionFailed'
  | 'RunQueued'
  | 'RunStarting'
  | 'RunCancelled'
  | 'RunPaused'
  | 'RunOrphaned'
  | 'TaskChanged'
  | 'ProjectChanged'
  | 'NodeChanged'
  | 'GitMerged'
  | 'Log'
  | 'Metrics';
export interface AgentEvent {
  type: EventType;
  data: Record<string, unknown>;
  key?: string;
}
export interface StoredEvent extends AgentEvent {
  seq: number;
  id: string;
  runId: string | null;
  sessionId: string | null;
  projectId: string | null;
  createdAt: string;
}
export type Metrics = z.infer<typeof metricsSchema>;
export interface AgentCapabilities {
  streaming: boolean;
  resume: boolean;
  interrupt: boolean;
  interactiveApproval: boolean;
  hardCpuRamLimits: boolean;
  tokenUsage: boolean;
  cost: 'unavailable' | 'estimate';
  remote: boolean;
}
export interface ProviderStatus {
  id: Provider;
  name: string;
  installed: boolean;
  authenticated: boolean | null;
  version: string | null;
  detail: string;
  capabilities: AgentCapabilities;
}
export interface Snapshot {
  trials: Trial[];
  attempts: TrialAttempt[];
  briefing: Briefing;
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  runs: Run[];
  workspaces: Workspace[];
  nodes: ComputeNode[];
  approvals: Approval[];
  artifacts: Artifact[];
  reservations: Reservation[];
  events: StoredEvent[];
  providers: ProviderStatus[];
  metrics: Record<string, Metrics>;
}

export function assertDag(tasks: Pick<Task, 'id' | 'dependencies'>[]) {
  const nodes = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Dependency cycle detected');
    if (done.has(id)) return;
    if (!nodes.has(id)) throw new Error('Dependency does not belong to this project');
    visiting.add(id);
    for (const dep of nodes.get(id)!) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}
export function assertTree(tasks: Pick<Task, 'id' | 'parentId'>[]) {
  assertDag(tasks.map((t) => ({ id: t.id, dependencies: t.parentId ? [t.parentId] : [] })));
}
export const now = () => new Date().toISOString();

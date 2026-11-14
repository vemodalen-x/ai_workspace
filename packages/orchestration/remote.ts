import { z } from 'zod';
import { jsonProcess } from '../agent-adapters/process.ts';
import type { AgentConfig } from '../agent-adapters/index.ts';
import type { AgentEvent, ComputeNode, Metrics, Provider, Workspace } from '../shared/index.ts';
export const sshNodeInput = z.object({
  name: z.string().min(1).max(100),
  sshAlias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/),
  workerPath: z
    .string()
    .regex(/^\/[a-zA-Z0-9_./-]+$/)
    .refine((s) => !s.split('/').includes('..')),
  cpu: z.number().int().positive().max(1024),
  ramMb: z.number().int().positive().max(1048576),
});
export interface RemoteRequest {
  op: 'probe' | 'metrics' | 'run';
  provider?: Provider;
  controllerMonitors?: boolean;
  sessionId?: string;
  runId?: string;
  repoPath?: string;
  baseCommit?: string;
  prompt?: string;
  providerSessionId?: string;
  model?: string;
  gpu?: string | null;
  timeoutSec?: number;
}
export async function remoteRequest(
  node: ComputeNode,
  request: RemoteRequest,
  signal: AbortSignal,
  onLine: (line: Record<string, unknown>) => void,
) {
  if (node.kind !== 'ssh' || !node.sshAlias || !node.workerPath)
    throw new Error('Invalid SSH node');
  sshNodeInput.parse(node);
  await jsonProcess({
    command: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=7',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      node.sshAlias,
      `node '${node.workerPath}'`,
    ],
    input: JSON.stringify(request) + '\n',
    keepStdinOpen: true,
    signal,
    onLine: (raw) => {
      const line = z.record(z.string(), z.unknown()).parse(raw);
      onLine(line);
    },
  });
}
export async function runRemote(
  node: ComputeNode,
  c: AgentConfig,
  provider: Provider,
  repoPath: string,
  baseCommit: string,
  emit: (e: AgentEvent) => void,
  onWorkspace: (w: Partial<Workspace>) => void,
  onMetrics: (m: Metrics) => void,
) {
  let finished = false;
  let diff = '';
  let error: string | undefined;
  await remoteRequest(
    node,
    {
      op: 'run',
      controllerMonitors: true,
      provider,
      repoPath,
      baseCommit,
      sessionId: c.sessionId,
      runId: c.runId,
      prompt: c.prompt,
      providerSessionId: c.providerSessionId,
      model: c.model,
      gpu: c.gpu,
    },
    c.signal,
    (line) => {
      if (line.kind === 'event') emit(line.event as unknown as AgentEvent);
      if (line.kind === 'workspace') onWorkspace(line.workspace as Partial<Workspace>);
      if (line.kind === 'metrics') onMetrics(line.metrics as unknown as Metrics);
      if (line.kind === 'complete') {
        finished = true;
        diff = String(line.diff ?? '');
      }
      if (line.kind === 'error') error = String(line.error);
    },
  );
  if (error) throw new Error(error);
  if (!finished) throw new Error('Remote connection ended without completion; outcome unknown');
  return diff;
}

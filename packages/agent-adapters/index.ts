import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { cli, probe, jsonProcess } from './process.ts';
import type { AgentCapabilities, AgentEvent, Provider, ProviderStatus } from '../shared/index.ts';

export interface AgentConfig {
  sessionId: string;
  runId: string;
  cwd: string;
  prompt: string;
  providerSessionId?: string;
  model?: string;
  gpu?: string | null;
  signal: AbortSignal;
  onPid?: (pid: number) => void;
}
export interface AgentAdapter {
  getCapabilities(): AgentCapabilities;
  run(config: AgentConfig, emit: (e: AgentEvent) => void): Promise<void>;
}
const caps: AgentCapabilities = {
  streaming: true,
  resume: true,
  interrupt: true,
  interactiveApproval: false,
  hardCpuRamLimits: false,
  tokenUsage: false,
  cost: 'unavailable',
  remote: true,
};
export class MockAdapter implements AgentAdapter {
  getCapabilities() {
    return { ...caps };
  }
  async run(c: AgentConfig, emit: (e: AgentEvent) => void) {
    emit({
      type: 'SessionStarted',
      data: { providerSessionId: c.providerSessionId ?? `mock-${c.sessionId}`, provider: 'mock' },
    });
    emit({
      type: 'MessageDelta',
      data: { text: 'Mock provider: running a deterministic local fixture. No model inference.\n' },
    });
    const instruction = c.prompt.split('\n\nCurrent instruction:\n').at(-1)!;
    await delay(instruction.includes('[slow]') ? 30000 : 350, undefined, { signal: c.signal });
    if (instruction.includes('[fail]')) throw new Error('Requested mock agent failure');
    emit({
      type: 'ToolStarted',
      data: {
        name: instruction.includes('[validate]')
          ? 'validate integration fixture'
          : 'write fixture file',
      },
    });
    if (instruction.includes('[validate]')) {
      const names = await readdir(join(c.cwd, 'agent-output'));
      const files = names.filter((f) => f.endsWith('.json'));
      if (files.length < 2)
        throw new Error('Integration fixture requires outputs from both dependency branches');
      for (const file of files)
        JSON.parse(await readFile(join(c.cwd, 'agent-output', file), 'utf8'));
      await writeFile(
        join(c.cwd, 'validation-report.json'),
        JSON.stringify({ passed: true, checked: files }, null, 2),
      );
      emit({
        type: 'ToolCompleted',
        data: {
          name: 'fixture validation',
          exitCode: 0,
          output: `Validated ${files.length} JSON outputs from dependency commits.`,
        },
      });
    } else {
      await mkdir(join(c.cwd, 'agent-output'), { recursive: true });
      const name = instruction.includes('[conflict]') ? 'shared.json' : `${c.sessionId}.json`;
      await writeFile(
        join(c.cwd, 'agent-output', name),
        JSON.stringify({ session: c.sessionId, run: c.runId, prompt: c.prompt }, null, 2),
      );
      emit({ type: 'FileChanged', data: { path: `agent-output/${name}`, kind: 'write' } });
      emit({
        type: 'ToolCompleted',
        data: { name: 'write fixture file', exitCode: 0, output: `Created agent-output/${name}` },
      });
    }
    emit({
      type: 'MessageDelta',
      data: { text: 'Fixture finished. Changes are isolated and ready for review.\n' },
    });
  }
}
export class CodexAdapter implements AgentAdapter {
  getCapabilities() {
    return { ...caps, tokenUsage: true };
  }
  async run(c: AgentConfig, emit: (e: AgentEvent) => void) {
    const sdk = new Codex({
      ...(process.env.CODEX_BIN ? { codexPathOverride: process.env.CODEX_BIN } : {}),
      ...(c.gpu !== null && c.gpu !== undefined
        ? {
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  (e): e is [string, string] => e[1] !== undefined,
                ),
              ),
              CUDA_VISIBLE_DEVICES: c.gpu,
            },
          }
        : {}),
    });
    const options: ThreadOptions = {
      workingDirectory: c.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      ...(c.model ? { model: c.model } : {}),
    };
    const thread = c.providerSessionId
      ? sdk.resumeThread(c.providerSessionId, options)
      : sdk.startThread(options);
    const { events } = await thread.runStreamed(c.prompt, { signal: c.signal });
    const seen = new Map<string, string>();
    let complete = false;
    for await (const e of events) {
      if (e.type === 'thread.started')
        emit({ type: 'SessionStarted', data: { providerSessionId: e.thread_id } });
      else if (e.type === 'turn.failed') throw new Error(e.error.message);
      else if (e.type === 'error') throw new Error(e.message);
      else if (e.type === 'turn.completed') {
        complete = true;
        emit({ type: 'UsageUpdated', data: { ...e.usage, cost: null, costKind: 'unavailable' } });
      } else if ('item' in e) {
        const item = e.item;
        if (item.type === 'agent_message') {
          const prev = seen.get(item.id) ?? '';
          const delta = item.text.startsWith(prev) ? item.text.slice(prev.length) : item.text;
          seen.set(item.id, item.text);
          if (delta) emit({ type: 'MessageDelta', data: { text: delta, itemId: item.id } });
        } else if (item.type === 'command_execution')
          emit({
            type: e.type === 'item.completed' ? 'ToolCompleted' : 'ToolStarted',
            data: {
              name: item.command,
              output: item.aggregated_output,
              exitCode: item.exit_code,
              itemId: item.id,
            },
            key: `${e.type}:${item.id}:${item.aggregated_output.length}`,
          });
        else if (item.type === 'file_change')
          emit({
            type: 'FileChanged',
            data: { changes: item.changes, status: item.status },
            key: `${e.type}:${item.id}`,
          });
        else if (item.type === 'mcp_tool_call')
          emit({
            type: e.type === 'item.completed' ? 'ToolCompleted' : 'ToolStarted',
            data: { name: `${item.server}/${item.tool}`, status: item.status },
          });
        else if (item.type === 'error')
          emit({ type: 'Log', data: { text: item.message, level: 'error' } });
      }
    }
    if (!complete) throw new Error('Codex stream ended without turn.completed');
  }
}
const object = z.record(z.string(), z.unknown());
const asObject = (v: unknown) =>
  object.safeParse(v).success ? (v as Record<string, unknown>) : {};
export class ClaudeAdapter implements AgentAdapter {
  constructor(private execute: typeof jsonProcess = jsonProcess) {}
  getCapabilities() {
    return { ...caps, tokenUsage: true, cost: 'estimate' as const };
  }
  async run(c: AgentConfig, emit: (e: AgentEvent) => void) {
    const spec = cli('claude');
    let completed = false;
    let resultError: string | undefined;
    const args = [
      ...spec.prefix,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read,Glob,Grep,Edit,Write',
      '--tools',
      'Read,Glob,Grep,Edit,Write',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ];
    if (c.providerSessionId) args.push('--resume', c.providerSessionId);
    if (c.model) args.push('--model', c.model);
    await this.execute({
      command: spec.command,
      args,
      cwd: c.cwd,
      env: {
        ...process.env,
        ...(c.gpu !== null && c.gpu !== undefined ? { CUDA_VISIBLE_DEVICES: c.gpu } : {}),
      },
      input: c.prompt,
      signal: c.signal,
      onPid: c.onPid,
      onErrorLine: (text) => emit({ type: 'Log', data: { text, level: 'stderr' } }),
      onLine: (raw) => {
        const e = asObject(raw);
        if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string')
          emit({ type: 'SessionStarted', data: { providerSessionId: e.session_id } });
        if (e.type === 'stream_event') {
          const event = asObject(e.event),
            delta = asObject(event.delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string')
            emit({ type: 'MessageDelta', data: { text: delta.text } });
        }
        if (e.type === 'assistant') {
          const m = asObject(e.message);
          if (Array.isArray(m.content))
            for (const rawBlock of m.content) {
              const b = asObject(rawBlock);
              if (b.type === 'tool_use')
                emit({
                  type: 'ToolStarted',
                  data: { name: b.name, input: b.input, toolId: b.id },
                  key: `tool:${String(b.id)}`,
                });
            }
        }
        if (e.type === 'user') {
          const m = asObject(e.message);
          if (Array.isArray(m.content))
            for (const rawBlock of m.content) {
              const b = asObject(rawBlock);
              if (b.type === 'tool_result')
                emit({
                  type: 'ToolCompleted',
                  data: { toolId: b.tool_use_id, output: b.content, isError: b.is_error },
                  key: `result:${String(b.tool_use_id)}`,
                });
            }
        }
        if (e.type === 'result') {
          completed = true;
          emit({
            type: 'UsageUpdated',
            data: {
              ...asObject(e.usage),
              costEstimateUsd: e.total_cost_usd ?? null,
              costKind: 'provider-estimate',
              costScope: 'conversation-cumulative',
            },
          });
          const denials = Array.isArray(e.permission_denials) ? e.permission_denials : [];
          if (e.is_error || e.subtype !== 'success' || denials.length) {
            resultError = denials.length
              ? 'Claude tool permission denied; adjust the native policy and explicitly retry'
              : String(e.result ?? JSON.stringify(e.errors ?? 'Claude execution failed'));
            if (denials.length)
              emit({
                type: 'ApprovalRequested',
                data: { supported: false, detail: resultError, denials },
              });
          }
        }
      },
    });
    if (resultError) throw new Error(resultError);
    if (!completed) throw new Error('Claude stream ended without a result');
  }
}
export const adapters: Record<Provider, AgentAdapter> = {
  mock: new MockAdapter(),
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
};
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const result: ProviderStatus[] = [
    {
      id: 'mock',
      name: 'Mock Agent',
      installed: true,
      authenticated: null,
      version: '1.0',
      detail: 'Deterministic test fixture · no inference',
      capabilities: adapters.mock.getCapabilities(),
    },
  ];
  for (const id of ['codex', 'claude'] as const) {
    let installed = false,
      version: string | null = null,
      authenticated: boolean | null = null,
      detail: string;
    try {
      version = (await probe(id, ['--version'])).stdout.trim();
      installed = true;
      const auth = await probe(id, id === 'codex' ? ['login', 'status'] : ['auth', 'status']);
      if (id === 'claude') {
        const data = JSON.parse(auth.stdout);
        authenticated = typeof data.loggedIn === 'boolean' ? data.loggedIn : null;
      } else authenticated = /logged in/i.test(auth.stdout + auth.stderr);
      detail = authenticated
        ? 'Native CLI login detected; entitlement checked only on explicit execution'
        : 'Authentication not verified';
    } catch (e) {
      detail = installed
        ? 'Not logged in or authentication status unavailable'
        : 'CLI not installed or could not start';
      if (installed && (e as { code?: unknown }).code === 1) authenticated = false;
    }
    result.push({
      id,
      name: id === 'codex' ? 'OpenAI Codex' : 'Claude Code',
      installed,
      authenticated,
      version,
      detail,
      capabilities: adapters[id].getCapabilities(),
    });
  }
  return result;
}

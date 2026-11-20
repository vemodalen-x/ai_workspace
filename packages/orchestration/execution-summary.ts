import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ExecutionSummary } from '../shared/execution-summary.ts';
import type { Session, StoredEvent } from '../shared/index.ts';
import { redact } from '../agent-adapters/process.ts';
import type { Store } from './store.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].slice(-40);
const clip = (value: string) => value.slice(-12000);

async function findHistory(root: string, session: Session) {
  const pending = [{ path: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory.path, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 20000) throw new Error('History search limit reached');
      const path = join(directory.path, entry.name);
      if (entry.isDirectory() && directory.depth < 4)
        pending.push({ path, depth: directory.depth + 1 });
      if (
        entry.isFile() &&
        (session.provider === 'codex'
          ? entry.name.endsWith(`-${session.providerSessionId}.jsonl`)
          : entry.name === `${session.providerSessionId}.jsonl`)
      )
        return path;
    }
  }
}

export async function loadHistory(
  session: Session,
  cwd: string,
  roots = {
    codex: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
    claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  },
): Promise<ExecutionSummary['histories'][number]> {
  const base = { sessionId: session.id, provider: session.provider };
  if (session.provider === 'mock' || session.nodeId !== 'local' || !session.providerSessionId)
    return {
      ...base,
      status: 'skipped',
      detail: 'No local provider history; using stored run events.',
    };
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(session.providerSessionId))
    return { ...base, status: 'unavailable', detail: 'Invalid provider session identifier.' };
  try {
    const source = await findHistory(await realpath(roots[session.provider]), session);
    if (!source) throw new Error('Local history not found');
    if ((await realpath(source)) !== source)
      throw new Error('History source symlinks are not supported');
    const file = await open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await file.stat();
      const current = await stat(source);
      if (
        (await realpath(source)) !== source ||
        info.dev !== current.dev ||
        info.ino !== current.ino
      )
        throw new Error('History source changed');
      if (!info.isFile()) throw new Error('History source is not a regular file');
      if (info.size > 32 * 1024 * 1024) throw new Error('History exceeds 32 MiB import limit');
      const stream = file.createReadStream({ autoClose: false, end: Math.max(0, info.size - 1) });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let verified = false;
      let malformed = 0;
      let conclusion = '';
      const commands: string[] = [];
      const files: string[] = [];
      try {
        for await (const line of lines) {
          if (line.length > 1024 * 1024) {
            malformed++;
            continue;
          }
          let entry: RecordValue;
          try {
            entry = object(JSON.parse(line));
          } catch {
            malformed++;
            continue;
          }
          const payload = object(entry.payload);
          if (session.provider === 'codex') {
            if (entry.type === 'session_meta') {
              if (payload.id !== session.providerSessionId || payload.cwd !== cwd)
                throw new Error('History session or worktree does not match');
              verified = true;
            }
            if (!verified || entry.type !== 'response_item') continue;
            if (
              payload.type === 'message' &&
              payload.role === 'assistant' &&
              (!payload.channel || payload.channel === 'final')
            ) {
              const content = Array.isArray(payload.content) ? payload.content : [];
              const message = content.map((block) => text(object(block).text)).join('\n');
              if (message) conclusion = clip(message);
            }
            if (payload.type === 'function_call') {
              let args: RecordValue = {};
              try {
                args = object(JSON.parse(text(payload.arguments)));
              } catch {
                continue;
              }
              const command = text(args.cmd) || text(args.command);
              if (command) commands.push(clip(command));
            }
            if (payload.type === 'custom_tool_call' && payload.name === 'exec')
              commands.push(clip(text(payload.input)));
            if (payload.type === 'custom_tool_call') {
              for (const match of text(payload.input).matchAll(
                /\*\*\* (?:Add|Update|Delete) File: (.+)/g,
              ))
                files.push(match[1]);
            }
          } else {
            if (entry.sessionId !== session.providerSessionId) continue;
            if (entry.cwd && entry.cwd !== cwd) throw new Error('History worktree does not match');
            if (entry.cwd === cwd) verified = true;
            const message = object(entry.message);
            const blocks = Array.isArray(message.content) ? message.content : [];
            if (entry.type !== 'assistant') continue;
            const messageText = blocks
              .map((block) => text(object(block).text))
              .filter(Boolean)
              .join('\n');
            if (messageText) conclusion = clip(messageText);
            for (const block of blocks) {
              const tool = object(block);
              const input = object(tool.input);
              if (tool.type !== 'tool_use') continue;
              if (tool.name === 'Bash' && input.command) commands.push(clip(text(input.command)));
              if (['Edit', 'Write', 'MultiEdit'].includes(text(tool.name)))
                files.push(text(input.file_path));
            }
          }
          if (commands.length > 80) commands.splice(0, 40);
          if (files.length > 80) files.splice(0, 40);
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!verified) throw new Error('No matching session and worktree metadata');
      return redact({
        ...base,
        status: 'loaded',
        source,
        conclusion,
        commands: unique(commands),
        files: unique(files),
        detail: `Session-wide history, not attributed to individual resumed runs. ${malformed} malformed/oversized records skipped. Tool calls are requests, not proof of success.`,
      }) as ExecutionSummary['histories'][number];
    } finally {
      await file.close();
    }
  } catch (error) {
    return {
      ...base,
      status: 'unavailable',
      detail: `Native history unavailable: ${(error as Error).message}. Stored run evidence remains available.`,
    };
  }
}

export async function taskExecutionSummary(
  store: Store,
  taskId: string,
  native = false,
): Promise<ExecutionSummary> {
  store.get('tasks', taskId);
  const sessions = store.all('sessions').filter((session) => session.taskId === taskId);
  const runs = store
    .all('runs')
    .filter((run) => run.taskId === taskId)
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const summaries = runs.map((run) => {
    const session = sessions.find((item) => item.id === run.sessionId);
    const rows = store.db
      .prepare('SELECT seq,type,data FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 20001')
      .all(run.id);
    const truncated = rows.length > 20000;
    const events = rows
      .slice(0, 20000)
      .reverse()
      .map((row) => ({ type: row.type, data: JSON.parse(String(row.data)) })) as Pick<
      StoredEvent,
      'type' | 'data'
    >[];
    let conclusion = '';
    const commands: string[] = [];
    const files: string[] = [];
    for (const event of events) {
      if (event.type === 'MessageDelta') conclusion = clip(conclusion + text(event.data.text));
      if (event.type === 'ToolStarted' || event.type === 'ToolCompleted') {
        const input = object(event.data.input);
        const command = text(input.command) || text(input.cmd) || text(event.data.name);
        if (command) commands.push(command.slice(0, 2000));
        if (input.file_path) files.push(text(input.file_path));
      }
      if (event.type === 'FileChanged' && Array.isArray(event.data.changes))
        for (const change of event.data.changes) files.push(text(object(change).path));
    }
    return {
      id: run.id,
      sessionId: run.sessionId,
      provider: session?.provider ?? 'unknown',
      model: session?.model,
      state: run.state,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      error: run.error,
      conclusion,
      commands: unique(commands),
      files: unique(files),
      evidenceCount: events.length,
      truncated,
    };
  });
  const histories = native
    ? await Promise.all(
        sessions.map((session) =>
          loadHistory(session, store.get('workspaces', session.workspaceId).path),
        ),
      )
    : [];
  return redact({
    taskId,
    generatedAt: new Date().toISOString(),
    method: 'evidence-extract',
    runs: summaries,
    histories,
  }) as ExecutionSummary;
}

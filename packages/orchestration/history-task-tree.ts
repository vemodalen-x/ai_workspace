import { createHash } from 'node:crypto';
import { redact } from '../agent-adapters/process.ts';
import type { HistoryTaskNode, NativeSession } from '../shared/native-history.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
function textContent(content: unknown, skipContext = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return '';
  return content
    .flatMap((b) =>
      b &&
      ['text', 'input_text'].includes(b.type) &&
      typeof b.text === 'string' &&
      (!skipContext || !injected(b.text))
        ? [b.text]
        : [],
    )
    .join('\n');
}
function injected(text: string) {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<permissions instructions>|<system-reminder>|<local-command-)/.test(
    text.trimStart(),
  );
}

// Message parent UUIDs are conversation links, not task dependencies. Only explicit
// tool plans become children; prose, tool results and assistant replies never do.
export function deriveHistoryTasks(
  session: NativeSession,
  text: string,
  offset = 0,
  maxNodes = 1000,
) {
  const rootId = `history:${session.provider}:${session.providerSessionId}`;
  const nodes: HistoryTaskNode[] = [
    {
      id: rootId,
      parentId: null,
      sessionId: session.id,
      provider: session.provider,
      kind: 'session',
      title: session.title || session.providerSessionId,
      description: session.cwd,
      state: 'recorded',
    },
  ];
  let current: HistoryTaskNode | undefined,
    skipped = 0,
    truncated = false;
  let lastRequest: { text: string; origin: string; index: number; timestamp?: string } | undefined;
  const plans = new Map<string, HistoryTaskNode>();
  const requestIds = new Set<string>();
  const lines = text.split('\n');
  lines.pop();
  for (const [index, line] of lines.entries()) {
    const sourceOffset = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    if (line.length > 512 * 1024) {
      skipped++;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!record || typeof record !== 'object') {
      skipped++;
      continue;
    }
    if (
      session.provider === 'claude' &&
      (record.sessionId !== session.providerSessionId ||
        record.isSidechain ||
        record.isMeta ||
        record.sourceToolAssistantUUID)
    )
      continue;
    const p = record.payload;
    const isEvent =
      session.provider === 'codex' && record.type === 'event_msg' && p?.type === 'user_message';
    const isResponse =
      session.provider === 'codex' &&
      record.type === 'response_item' &&
      p?.type === 'message' &&
      p.role === 'user';
    const isClaude = session.provider === 'claude' && record.type === 'user';
    const requestText = isEvent
      ? p.message
      : isResponse
        ? textContent(p.content, true)
        : isClaude
          ? textContent(record.message?.content)
          : '';
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
    if (typeof requestText === 'string' && requestText.trim() && !injected(requestText)) {
      const origin = isEvent ? 'event' : 'message';
      const duplicate =
        lastRequest &&
        lastRequest.origin !== origin &&
        lastRequest.text === requestText &&
        index - lastRequest.index < 5 &&
        (!timestamp ||
          !lastRequest.timestamp ||
          Math.abs(Date.parse(timestamp) - Date.parse(lastRequest.timestamp)) <= 2000);
      if (duplicate) continue;
      const identity = record.uuid ?? record.ordinal ?? p?.id ?? sourceOffset;
      const id = rootId + ':request:' + digest(String(identity));
      if (requestIds.has(id)) continue;
      requestIds.add(id);
      if (nodes.length >= maxNodes) {
        truncated = true;
        current = undefined;
        continue;
      }
      const clean = redact(requestText) as string;
      current = {
        id,
        parentId: rootId,
        sessionId: session.id,
        provider: session.provider,
        kind: 'request',
        title: clean.trim().split('\n').find(Boolean)!.slice(0, 120),
        description: clean.slice(0, 4000),
        state: 'recorded',
        timestamp,
        sourceOffset,
      };
      nodes.push(current);
      if (clean.length > 4000) truncated = true;
      lastRequest = { text: requestText, origin, index, timestamp };
    }
    const calls: { name?: unknown; input?: unknown; id?: unknown }[] = [];
    if (
      session.provider === 'codex' &&
      record.type === 'response_item' &&
      p?.type === 'function_call'
    ) {
      try {
        calls.push({
          name: p.name,
          input: typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments,
          id: p.call_id,
        });
      } catch {
        skipped++;
      }
    }
    if (
      session.provider === 'claude' &&
      record.type === 'assistant' &&
      Array.isArray(record.message?.content)
    ) {
      for (const block of record.message.content)
        if (block?.type === 'tool_use')
          calls.push({ name: block.name, input: block.input, id: block.id });
    }
    for (const call of calls) {
      const name = typeof call.name === 'string' ? call.name : '';
      if (!['update_plan', 'functions.update_plan', 'TodoWrite'].includes(name)) continue;
      const input = call.input as { plan?: unknown; todos?: unknown } | undefined;
      const steps = name === 'TodoWrite' ? input?.todos : input?.plan;
      if (!Array.isArray(steps)) {
        skipped++;
        continue;
      }
      if (!current) {
        skipped++;
        continue;
      }
      for (const step of steps) {
        const content = step?.step ?? step?.content;
        if (typeof content !== 'string' || !content.trim()) {
          skipped++;
          continue;
        }
        const status = ['pending', 'in_progress', 'completed'].includes(step.status)
          ? (step.status as HistoryTaskNode['state'])
          : 'recorded';
        const identity = step.id !== undefined ? String(step.id) : content;
        const id = current.id + ':plan:' + digest(identity);
        const existing = plans.get(id);
        if (existing) {
          const clean = redact(content) as string;
          Object.assign(existing, {
            state: status,
            title: clean.slice(0, 120),
            description: clean.slice(0, 4000),
            timestamp,
            sourceOffset,
          });
          if (clean.length > 4000) truncated = true;
          continue;
        }
        if (nodes.length >= maxNodes) {
          truncated = true;
          continue;
        }
        const clean = redact(content) as string;
        const node: HistoryTaskNode = {
          id,
          parentId: current.id,
          sessionId: session.id,
          provider: session.provider,
          kind: 'plan',
          title: clean.slice(0, 120),
          description: clean.slice(0, 4000),
          state: status,
          timestamp,
          sourceOffset,
        };
        if (clean.length > 4000) truncated = true;
        plans.set(id, node);
        nodes.push(node);
      }
    }
  }
  return { nodes, skipped, truncated };
}

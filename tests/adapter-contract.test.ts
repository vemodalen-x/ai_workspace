import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../packages/agent-adapters/index.ts';
import type { AgentEvent } from '../packages/shared/index.ts';
const config = {
  sessionId: 's',
  runId: 'r',
  cwd: '.',
  prompt: 'hello',
  signal: new AbortController().signal,
  providerSessionId: 'existing-session',
};

test('Claude adapter uses supported structured flags, resume and normalizes JSONL events', async () => {
  const events: AgentEvent[] = [];
  const adapter = new ClaudeAdapter(async (c) => {
    assert.ok(c.args.includes('--resume'));
    assert.ok(c.args.includes('existing-session'));
    assert.ok(c.args.includes('stream-json'));
    assert.equal(c.args.includes('--dangerously-skip-permissions'), false);
    c.onLine({ type: 'system', subtype: 'init', session_id: 'native-session' });
    c.onLine({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } });
    c.onLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool1', name: 'Write', input: { file_path: 'a.ts' } }],
      },
    });
    c.onLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'Done' }] },
    });
    c.onLine({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 3 },
      total_cost_usd: 0.0001,
    });
  });
  await adapter.run(config, (e) => events.push(e));
  assert.deepEqual(
    events.map((e) => e.type),
    ['SessionStarted', 'MessageDelta', 'ToolStarted', 'ToolCompleted', 'UsageUpdated'],
  );
  assert.equal(events.at(-1)?.data.costKind, 'provider-estimate');
  assert.equal(events.at(-1)?.data.costScope, 'conversation-cumulative');
});
test('Claude adapter refuses success for denied permissions or missing final result', async () => {
  const denied = new ClaudeAdapter(async (c) =>
    c.onLine({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Bash' }] }),
  );
  const events: AgentEvent[] = [];
  await assert.rejects(
    denied.run(config, (e) => events.push(e)),
    /permission denied/,
  );
  assert.ok(events.some((e) => e.type === 'ApprovalRequested' && e.data.supported === false));
  const truncated = new ClaudeAdapter(async (c) =>
    c.onLine({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Partial' } } }),
  );
  await assert.rejects(
    truncated.run(config, () => {}),
    /without a result/,
  );
});

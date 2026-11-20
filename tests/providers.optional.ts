import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, key, settle } from './helpers.ts';
for (const provider of ['codex', 'claude'] as const)
  test(
    `OPTIONAL PAID provider: ${provider}`,
    { skip: process.env.RUN_REAL_PROVIDER_TESTS !== provider },
    async () => {
      const { svc, project } = await fixture();
      try {
        await svc.refreshProviders();
        const t = svc.saveTask(project.id, {
          title: `Real ${provider} smoke`,
          provider,
          description:
            'Read README.md and reply with exactly WORKSPACE_OK. Do not change files or run commands.',
          allocation: { timeoutSec: 120 },
        });
        const r = svc.enqueue(t.id, { requestKey: key(), allowReal: true });
        await settle(svc, [r.id], 130000);
        assert.equal(svc.store.get('runs', r.id).state, 'completed');
        const text = svc.store
          .events()
          .filter((e) => e.runId === r.id && e.type === 'MessageDelta')
          .map((e) => String(e.data.text))
          .join('');
        assert.ok(text.includes('WORKSPACE_OK'));
      } finally {
        await svc.shutdown();
      }
    },
  );

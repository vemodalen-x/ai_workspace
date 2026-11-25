import { browseFolders } from '../../../packages/orchestration/local-folders.ts';
import { NativeHistoryReader } from '../../../packages/orchestration/native-history.ts';
import { SessionIndex } from '../../../packages/orchestration/session-index.ts';
import {
  ExternalSessions,
  externalSessionInput,
} from '../../../packages/orchestration/external-sessions.ts';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Orchestrator } from '../../../packages/orchestration/service.ts';
import { taskInput, type StoredEvent } from '../../../packages/shared/index.ts';
import { redact } from '../../../packages/agent-adapters/process.ts';
import { modelCatalog } from '../../../packages/agent-adapters/models.ts';
import { reasoningEffortSchema } from '../../../packages/shared/models.ts';
import { taskExecutionSummary } from '../../../packages/orchestration/execution-summary.ts';
import manifest from '../../../package.json' with { type: 'json' };

declare const __WORKSPACE_BUILD_COMMIT__: string | null;
const buildCommit =
  typeof __WORKSPACE_BUILD_COMMIT__ === 'undefined' ? null : __WORKSPACE_BUILD_COMMIT__;

const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  repoPath: z.string().min(1).max(4096),
  concurrency: z.number().int().min(1).max(32).default(2),
});
const runInput = z.object({
  requestKey: z.string().min(8).max(200),
  prompt: z.string().max(40000).optional(),
  sessionId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  allowReal: z.boolean().default(false),
  allowValidation: z.boolean().default(false),
});
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function createApp(
  service: Orchestrator,
  options: {
    token?: string;
    serveWeb?: boolean;
    allowedOrigins?: string[];
    monitor?: SessionIndex;
  } = {},
) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 30000 });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: 'Untrusted Host' });
    const origin = req.headers.origin;
    if (
      origin &&
      !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin) &&
      !options.allowedOrigins?.includes(origin)
    )
      return reply.code(403).send({ error: 'Untrusted Origin' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Cross-site requests rejected' });
    if (req.url.startsWith('/api/') && req.url.split('?')[0] !== '/api/bootstrap') {
      const protocol = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((p) => p.trim())
        .find((p) => p.startsWith('auth.'))
        ?.slice(5);
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? protocol ?? '';
      if (!same(supplied, token))
        return reply.code(401).send({ error: 'Local API authentication required' });
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error;
    const status = e instanceof z.ZodError ? 400 : /not found/.test(e.message) ? 404 : 409;
    reply.code(status).send(redact({ error: e.message.slice(0, 4000) }));
  });
  app.get('/api/bootstrap', async () => ({ token, version: manifest.version, buildCommit }));
  app.get('/api/snapshot', async () => service.snapshot());
  const native = new NativeHistoryReader();
  const registeredProject = (id: string) => {
    const project = service.store.get('projects', id);
    if (project.removedAt) throw new Error('Project not found');
    return project;
  };
  app.get('/api/local-folders', async (req) => {
    const query = z.object({ path: z.string().min(1).max(4096).optional() }).parse(req.query);
    return browseFolders(query.path);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/local-history', async (req) => {
    const query = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    return native.scan(registeredProject(req.params.id).repoPath, query.refresh === 'true');
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/history-task-tree', async (req) => {
    const query = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    return native.taskTree(registeredProject(req.params.id).repoPath, query.refresh === 'true');
  });
  app.get<{ Params: { id: string; session: string } }>(
    '/api/projects/:id/local-history/:session',
    async (req) =>
      native.output(
        registeredProject(req.params.id).repoPath,
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.params.session),
      ),
  );
  // Read-only monitor over native CLI / IDE transcripts. It never starts or controls them.
  const monitor = options.monitor ?? new SessionIndex();
  app.get('/api/monitor/overview', async (req) => {
    const query = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    return monitor.overview(service.snapshot(), { refresh: query.refresh === 'true' });
  });
  app.get<{ Params: { id: string } }>('/api/monitor/sessions/:id/output', async (req) =>
    monitor.output(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.params.id),
    ),
  );
  const external = new ExternalSessions(service.store);
  app.get<{ Params: { id: string } }>('/api/projects/:id/external-sessions', async (req) =>
    external.list(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/external-sessions', async (req) =>
    service.serial(() => external.attach(req.params.id, externalSessionInput.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>('/api/external-sessions/:id/output', async (req) =>
    external.output(req.params.id),
  );
  app.delete<{ Params: { id: string } }>('/api/external-sessions/:id', async (req) =>
    service.serial(async () => {
      external.detach(req.params.id);
      return { ok: true };
    }),
  );
  app.get('/api/models', async () => modelCatalog());
  app.get('/api/assistant', async () => service.snapshot().briefing);
  app.get('/api/events', async (req) => {
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(2000).default(1000),
      })
      .parse(req.query);
    return service.store.events(query.after, query.limit);
  });
  app.get('/api/events/ws', { websocket: true }, (socket, req) => {
    const cursor = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .safeParse(req.query);
    if (!cursor.success) {
      socket.close(1008, 'Invalid cursor');
      return;
    }
    let after = cursor.data.after;
    const send = (event: StoredEvent) => {
      if (event.seq <= after || socket.readyState !== 1) return;
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.close(1013, 'Reconnect with cursor');
        return;
      }
      socket.send(JSON.stringify(event));
      after = event.seq;
    };
    service.store.bus.on('event', send);
    let batch: StoredEvent[];
    do {
      batch = service.store.events(after, 1000);
      for (const e of batch) send(e);
    } while (batch.length === 1000 && socket.readyState === 1);
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
    }, 20000);
    socket.on('close', () => {
      clearInterval(ping);
      service.store.bus.off('event', send);
    });
    socket.on('error', () => {});
  });
  app.post('/api/projects', async (req) =>
    service.serial(() => service.createProject(projectInput.parse(req.body))),
  );
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) =>
    service.serial(async () =>
      service.updateProject(
        req.params.id,
        z
          .object({
            name: z.string().min(1).max(100).optional(),
            concurrency: z.number().int().min(1).max(32).optional(),
            archived: z.boolean().optional(),
            context: z.string().max(12000).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) =>
    service.serial(async () => service.deleteProject(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req) =>
    service.serial(async () => service.saveTask(req.params.id, taskInput.parse(req.body))),
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/trials', async (req) =>
    service.serial(() => service.trials.create(req.params.id, req.body)),
  );
  app.post<{ Params: { id: string } }>('/api/trials/:id/attempts', async (req) => {
    const { requestKey } = z
      .object({ confirmed: z.literal(true), requestKey: z.string().uuid() })
      .parse(req.body);
    return service.trials.enqueue(req.params.id, requestKey);
  });
  app.get<{ Params: { id: string } }>('/api/attempts/:id/output', async (req) =>
    service.trials.output(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/attempts/:id/cancel', async (req) => {
    service.trials.cancel(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/attempts/:id/reconcile', async (req) => {
    z.object({ confirmedStopped: z.literal(true) }).parse(req.body);
    service.trials.reconcile(req.params.id);
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) =>
    service.serial(async () => {
      const old = service.store.get('tasks', req.params.id);
      return service.saveTask(
        old.projectId,
        { ...old, ...taskInput.partial().parse(req.body) },
        old.id,
      );
    }),
  );
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req) =>
    service.serial(async () => service.deleteTask(req.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/tasks/:id/summary', async (req) => {
    const query = z
      .object({ history: z.enum(['true', 'false']).default('false') })
      .parse(req.query);
    return taskExecutionSummary(service.store, req.params.id, query.history === 'true');
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/runs', async (req) =>
    service.serial(async () => service.enqueue(req.params.id, runInput.parse(req.body))),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) => {
    const { mode } = z
      .object({ mode: z.enum(['paused', 'cancelled']).default('cancelled') })
      .parse(req.body ?? {});
    service.cancel(req.params.id, mode);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/reconcile', async (req) => {
    service.reconcile(
      req.params.id,
      z.object({ confirmedStopped: z.literal(true) }).parse(req.body).confirmedStopped,
    );
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/diff', async (req) => ({
    diff: await service.diff(req.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/merge-preview', async (req) =>
    service.serial(() => service.previewMerge(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cleanup', async (req) =>
    service.serial(async () => {
      z.object({ confirmed: z.literal(true) }).parse(req.body);
      await service.cleanup(req.params.id);
      return { ok: true };
    }),
  );
  app.post<{ Params: { id: string } }>('/api/approvals/:id', async (req) =>
    service.serial(async () => {
      const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
      await service.decideApproval(req.params.id, approved);
      return { ok: true };
    }),
  );
  app.post<{ Params: { id: string } }>('/api/approvals/:id/reconcile', async (req) =>
    service.serial(() => service.reconcileMerge(req.params.id)),
  );
  app.post('/api/nodes', async (req) => service.addNode(req.body));
  app.post<{ Params: { id: string } }>('/api/nodes/:id/probe', async (req) => {
    await service.probeNode(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/nodes/:id/telemetry', async (req) => {
    service.store.get('nodes', req.params.id);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(2160).default(120) })
      .parse(req.query);
    return service.telemetry.history(req.params.id, limit);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/telemetry', async (req) => {
    const run = service.store.get('runs', req.params.id);
    if (run.telemetryAtFinish) return { window: run.telemetryAtFinish };
    if (!run.startedAt || (!run.endedAt && !['starting', 'running'].includes(run.state)))
      return { window: null };
    return {
      window: service.telemetry.runWindow(
        run.nodeId,
        run.manifest?.environment.gpuId ?? null,
        run.startedAt,
        run.endedAt ?? new Date().toISOString(),
      ),
    };
  });
  app.post('/api/providers/refresh', async () => service.refreshProviders());
  app.post('/api/scheduler/tick', async () => {
    await service.tick();
    return { ok: true };
  });
  const web = resolve('dist/web');
  if (options.serveWeb !== false && existsSync(web)) {
    await app.register(staticFiles, { root: web, prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  }
  return { app, token, monitor };
}

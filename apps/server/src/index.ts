import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Orchestrator } from '../../../packages/orchestration/service.ts';
import { acquireInstance } from '../../../packages/local-instance/index.ts';
import { createApp } from './app.ts';

const dataDir = resolve(process.env.WORKSPACE_DATA_DIR ?? '.workspace');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const instance = await acquireInstance(dataDir, () => void close());
let service: Orchestrator | undefined;
let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
const timers: NodeJS.Timeout[] = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  timers.forEach(clearInterval);
  try {
    await app?.close();
    await service?.shutdown();
  } finally {
    await instance.close();
  }
}

try {
  const workspace = (service = new Orchestrator(dataDir));
  await workspace.recoverMerges();
  ({ app } = await createApp(workspace, {
    allowedOrigins: (process.env.WORKSPACE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  }));
  const address = await app.listen({
    host: '127.0.0.1',
    port: Number(process.env.API_PORT ?? 4310),
  });
  instance.ready(address);
  console.log('AI Agent Workspace API: ' + address);
  void workspace.refreshProviders().catch((e) => console.error('Provider check:', e.message));
  let sampling = false;
  timers.push(
    setInterval(() => {
      if (sampling) return;
      sampling = true;
      void workspace
        .sample()
        .catch(() => {})
        .finally(() => {
          sampling = false;
        });
    }, 3000),
  );
  timers.push(setInterval(() => void workspace.sampleRemote().catch(() => {}), 3000));
  timers.push(
    setInterval(() => {
      void workspace.tick().catch((e) => console.error('Scheduler:', e.message));
    }, 300),
  );
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  await close();
  throw error;
}

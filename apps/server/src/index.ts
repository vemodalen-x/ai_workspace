import { resolve } from 'node:path';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { Orchestrator } from '../../../packages/orchestration/service.ts';
import { createApp } from './app.ts';
const dataDir = resolve(process.env.WORKSPACE_DATA_DIR ?? '.workspace');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
// A crash leaves this file intentionally: inspect processes before explicitly removing it.
const lockPath = resolve(dataDir, 'server.lock');
let lock: FileHandle | undefined;
try {
  lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
} catch {
  throw new Error(
    `Another server may own this database. Inspect ${lockPath}; remove only after confirming the previous process stopped.`,
  );
}
const service = new Orchestrator(dataDir);
await service.recoverMerges();
const { app } = await createApp(service, {
  allowedOrigins: (process.env.WORKSPACE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.API_PORT ?? 4310) });
console.log(`AI Agent Workspace API: http://127.0.0.1:${process.env.API_PORT ?? 4310}`);
void service.refreshProviders();
let sampling = false;
const metricsTimer = setInterval(() => {
  if (!sampling) {
    sampling = true;
    void service
      .sample()
      .catch(() => {})
      .finally(() => {
        sampling = false;
      });
  }
}, 3000);
const remoteMetricsTimer = setInterval(() => {
  void service.sampleRemote().catch(() => {});
}, 3000);
const schedulerTimer = setInterval(() => {
  void service.tick().catch((e) => console.error('Scheduler:', e.message));
}, 300);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(metricsTimer);
  clearInterval(remoteMetricsTimer);
  clearInterval(schedulerTimer);
  await app.close();
  await service.shutdown();
  await lock?.close();
  await unlink(lockPath);
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

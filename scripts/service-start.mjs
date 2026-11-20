import process from 'node:process';
import console from 'node:console';
import { setInterval, clearInterval } from 'node:timers';
import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat, rename, mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function bootId() {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
}

// The systemd unit holds service.guard with flock for this entire process tree.
// The server's own exclusive lock still protects against unmanaged instances.
export async function prepareServiceLock(dataDir, currentBoot = undefined) {
  const lockPath = resolve(dataDir, 'server.lock');
  let stat;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile()) throw new Error('Refusing non-regular server.lock');
  const lock = await readJson(lockPath);
  const modern = typeof lock?.key === 'string' && /^[a-f0-9]{64}$/.test(lock.key);
  if (
    !Number.isSafeInteger(lock?.pid) ||
    lock.pid <= 0 ||
    (!modern && typeof lock.startedAt !== 'string')
  )
    throw new Error('Invalid server.lock; inspect it manually');
  const owner = await readJson(resolve(dataDir, '.service-owner.json'));
  const previousBoot =
    owner?.pid === lock.pid &&
    (modern ? owner.key === lock.key : owner.startedAt === lock.startedAt) &&
    typeof owner.bootId === 'string' &&
    owner.bootId !== (currentBoot ?? (await bootId()));
  if (!previousBoot) {
    try {
      process.kill(lock.pid, 0);
      throw new Error(`Server PID ${lock.pid} is still alive; refusing to remove its lock`);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const latest = await lstat(lockPath);
  if (latest.ino !== stat.ino || latest.mtimeMs !== stat.mtimeMs || latest.size !== stat.size)
    throw new Error('Server lock changed during inspection; refusing recovery');
  const archived = `${lockPath}.recovered-${Date.now()}`;
  await rename(lockPath, archived);
  console.log(`Recovered stale server lock for PID ${lock.pid}: ${archived}`);
}

async function start() {
  const dataDir = resolve(process.env.WORKSPACE_DATA_DIR ?? '.workspace');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const currentBoot = await bootId();
  await prepareServiceLock(dataDir, currentBoot);
  const child = spawn(process.execPath, [resolve('dist/server/src/index.js')], {
    stdio: 'inherit',
    env: { ...process.env, WORKSPACE_DATA_DIR: dataDir },
  });
  const timer = setInterval(() => {
    void (async () => {
      const lock = await readJson(resolve(dataDir, 'server.lock'));
      if (lock?.pid !== child.pid) return;
      clearInterval(timer);
      const ownerPath = resolve(dataDir, '.service-owner.json');
      const temporary = `${ownerPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...lock, bootId: currentBoot }), { mode: 0o600 });
      await rename(temporary, ownerPath);
    })().catch((error) => console.error('Service owner metadata:', error.message));
  }, 100);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    clearInterval(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    clearInterval(timer);
    process.exitCode = code ?? 1;
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href
) {
  await start();
}

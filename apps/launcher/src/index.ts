import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../../../package.json' with { type: 'json' };
import { contactInstance } from '../../../packages/local-instance/index.ts';
import { cli } from '../../../packages/agent-adapters/process.ts';

const windows = process.platform === 'win32';
const installDir = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = resolve(
  process.env.WORKSPACE_DATA_DIR ??
    (windows
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
          'AI Agent Workspace',
          'data',
        )
      : join(
          process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
          'ai-agent-workspace',
        )),
);
const log = join(dataDir, 'server.log');
const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
process.env[pathKey] = dirname(process.execPath) + delimiter + (process.env[pathKey] ?? '');

async function start() {
  const current = await contactInstance(dataDir, 'status');
  if (current?.url) return current.url;
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const version = /git version (\d+)\.(\d+)/.exec(git.stdout ?? '');
  if (!version || +version[1] < 2 || (+version[1] === 2 && +version[2] < 38))
    throw new Error('Install Git 2.38 or newer and add git to PATH, then launch again.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (((await stat(log).catch(() => undefined))?.size ?? 0) > 2 * 1024 * 1024)
    await rename(log, log + '.previous').catch(() => {});
  const out = await open(log, 'a', 0o600);
  let exited = false;
  try {
    const child = spawn(process.execPath, [join(installDir, 'dist/server/src/index.js')], {
      cwd: installDir,
      env: { ...process.env, WORKSPACE_DATA_DIR: dataDir },
      stdio: ['ignore', out.fd, out.fd],
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {
      exited = true;
    });
    child.once('exit', () => {
      exited = true;
    });
    child.unref();
  } finally {
    await out.close();
  }
  for (let i = 0; i < 300; i++) {
    await delay(100);
    const state = await contactInstance(dataDir, 'status');
    if (state?.url) return state.url;
    if (exited && !state && i >= 10) break;
  }
  const tail = (await readFile(log, 'utf8')).split('\n').slice(-25).join('\n');
  if (tail.includes('EADDRINUSE') && tail.includes('127.0.0.1'))
    throw new Error(
      'The local port is in use. Set API_PORT to a free port and start again. Log: ' + log,
    );
  throw new Error('The server did not become ready. See ' + log);
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === '--version') return console.log(manifest.version);
  if (command === '--help')
    return console.log(
      'ai-agent-workspace [start [--no-browser] | status | stop | login codex | --version]\nData: ' +
        dataDir,
    );
  if (command === 'login' && args.join(' ') === 'codex') {
    const spec = cli('codex');
    const result = spawnSync(spec.command, [...spec.prefix, 'login'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'start' && args.every((arg) => arg === '--no-browser')) {
    const address = await start();
    console.log(address);
    if (!args.includes('--no-browser')) {
      const browser = spawn(
        windows ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open',
        windows ? ['url.dll,FileProtocolHandler', address] : [address],
        { detached: true, windowsHide: true, stdio: 'ignore' },
      );
      browser.on('error', () => console.error('Open the URL printed above in your browser.'));
      browser.unref();
    }
    return;
  }
  if ((command === 'stop' || command === 'status') && !args.length) {
    const state = await contactInstance(dataDir, command);
    if (command === 'stop' && state) {
      for (let i = 0; i < 600; i++) {
        await delay(100);
        if (!(await contactInstance(dataDir, 'status'))) return console.log('Stopped.');
      }
      throw new Error('Shutdown is still in progress. See ' + log);
    }
    return console.log(state ? state.url || 'Starting.' : 'Stopped.');
  }
  throw new Error('Unknown command. Run ai-agent-workspace --help.');
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

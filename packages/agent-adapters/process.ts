import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const require = createRequire(import.meta.url);
export function cli(provider: 'codex' | 'claude'): { command: string; prefix: string[] } {
  const override = process.env[provider === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN'];
  if (override) return { command: override, prefix: [] };
  try {
    const pkg = require.resolve(
      provider === 'codex'
        ? '@openai/codex/package.json'
        : '@anthropic-ai/claude-code/package.json',
    );
    return provider === 'codex'
      ? { command: process.execPath, prefix: [join(dirname(pkg), 'bin/codex.js')] }
      : { command: join(dirname(pkg), 'bin/claude.exe'), prefix: [] };
  } catch {
    return { command: provider, prefix: [] };
  }
}
export async function probe(provider: 'codex' | 'claude', args: string[]) {
  const c = cli(provider);
  return promisify(execFile)(c.command, [...c.prefix, ...args], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}
export function terminateTree(child: ChildProcess, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill(force ? 'SIGKILL' : 'SIGTERM'));
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }
}
export async function jsonProcess(config: {
  command: string;
  args: string[];
  cwd?: string;
  input: string;
  keepStdinOpen?: boolean;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onLine: (data: unknown) => void;
  onErrorLine?: (text: string) => void;
  onPid?: (pid: number) => void;
}) {
  config.signal.throwIfAborted();
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  if (child.pid) config.onPid?.(child.pid);
  let escalation: NodeJS.Timeout | undefined, parseError: Error | undefined;
  const stop = () => {
    if (escalation) return;
    terminateTree(child);
    escalation = setTimeout(() => terminateTree(child, true), 2500);
  };
  config.signal.addEventListener('abort', stop, { once: true });
  let lineBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    lineBytes += chunk.length;
    if (chunk.includes(10)) lineBytes = chunk.length - chunk.lastIndexOf(10) - 1;
    if (lineBytes > 4 * 1024 * 1024) {
      parseError = new Error('Provider JSON line exceeds 4 MiB limit');
      stop();
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      if (line.trim()) config.onLine(JSON.parse(line));
    } catch (e) {
      parseError = e instanceof Error ? e : new Error(String(e));
      stop();
    }
  });
  child.stderr.on('data', (b: Buffer) => config.onErrorLine?.(b.toString().slice(0, 16000)));
  child.stdin.on('error', () => {});
  if (config.keepStdinOpen) child.stdin.write(config.input);
  else child.stdin.end(config.input);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (config.signal.aborted) reject(new Error('Execution interrupted'));
        else if (parseError) reject(parseError);
        else if (code !== 0) reject(new Error(`Process exited with code ${code}`));
        else resolve();
      });
    });
  } finally {
    if (escalation) {
      clearTimeout(escalation);
      // The parent can exit before its descendants; finish cancelling the owned group.
      terminateTree(child, true);
    }
    config.signal.removeEventListener('abort', stop);
    lines.close();
  }
}
export async function validateCommand(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  emit: (text: string) => void,
  gpu?: string | null,
  onStdout?: (chunk: Buffer) => void,
) {
  if (!argv.length) return;
  const code = await runLocalCommand(argv, cwd, signal, {
    env: gpu ? { ...process.env, CUDA_VISIBLE_DEVICES: gpu } : process.env,
    output: (chunk, stream) => {
      if (stream === 'stdout') onStdout?.(chunk);
      emit(chunk.toString().slice(0, 32000));
    },
  });
  if (code !== 0) throw new Error(`Validation command exited with code ${code}`);
}

export async function runLocalCommand(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  options: {
    env: NodeJS.ProcessEnv;
    output: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
    onPid?: (pid: number) => void;
  },
) {
  signal.throwIfAborted();
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) options.onPid?.(child.pid);
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    if (escalation) return;
    terminateTree(child);
    escalation = setTimeout(() => terminateTree(child, true), 2500);
  };
  signal.addEventListener('abort', stop, { once: true });
  let outputError: unknown;
  for (const stream of ['stdout', 'stderr'] as const)
    child[stream].on('data', (chunk: Buffer) => {
      if (outputError) return;
      try {
        options.output(chunk, stream);
      } catch (error) {
        outputError = error;
        stop();
      }
    });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, bySignal) => {
        if (outputError) reject(outputError);
        else if (signal.aborted) reject(new Error('Command interrupted'));
        else if (code === null) reject(new Error(`Command terminated by ${bySignal}`));
        else resolve(code);
      });
    });
  } finally {
    if (escalation) {
      clearTimeout(escalation);
      terminateTree(child, true);
    }
    signal.removeEventListener('abort', stop);
  }
}
export function redact(value: unknown): unknown {
  let text = JSON.stringify(value);
  for (const [key, secret] of Object.entries(process.env))
    if (/TOKEN|PASSWORD|SECRET|API_KEY/i.test(key) && secret && secret.length >= 8)
      text = text.replaceAll(secret, '[REDACTED]');
  text = text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  return JSON.parse(text);
}

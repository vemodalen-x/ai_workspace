import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, dirname, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { localFolder } from './local-folders.ts';
import { redact } from '../agent-adapters/process.ts';
import type {
  NativeConfig,
  NativeHistory,
  NativeOutput,
  NativeProvider,
  NativeSession,
} from '../shared/native-history.ts';

const limit = 1024 * 1024;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel !== '..' &&
    !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
    !isAbsolute(rel)
  );
};
const state = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? ('missing' as const)
    : ('unreadable' as const);

// Reject symlinked records and replaced files. Never accept a client-supplied transcript path.
async function readWindow(root: string, path: string, tail = false, max = limit) {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (!inside(canonicalRoot, canonical) || canonical !== resolve(path))
    throw new Error('History source symlinks are not supported');
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    const current = await stat(path);
    if (
      !info.isFile() ||
      info.ino !== current.ino ||
      info.dev !== current.dev ||
      (await realpath(path)) !== canonical
    )
      throw new Error('History source changed or is not a regular file');
    const size = Math.min(info.size, max),
      start = tail ? info.size - size : 0;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return {
      text,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      truncated: info.size > size,
    };
  } finally {
    await file.close();
  }
}
function records(text: string) {
  const values: Record<string, unknown>[] = [];
  let skipped = 0;
  const lines = text.split('\n');
  lines.pop(); // Do not parse a writer's unfinished record.
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      if (line.length > 512 * 1024) throw new Error('Oversized record');
      const value = JSON.parse(line);
      if (value && typeof value === 'object') values.push(value);
    } catch {
      skipped++;
    }
  }
  return { values, skipped };
}
async function matches(cwd: unknown, project: string) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  try {
    return (await realpath(cwd)) === project;
  } catch {
    return false;
  }
}
async function metadataWindow(root: string, path: string, provider: NativeProvider) {
  let data = await readWindow(root, path, false, 256 * 1024);
  const metadataOf = (text: string) => {
    const values = records(text).values;
    return provider === 'codex'
      ? (values.find((r) => r.type === 'session_meta')?.payload as
          Record<string, unknown> | undefined)
      : values.find((r) => typeof r.cwd === 'string');
  };
  let metadata = metadataOf(data.text);
  let readBytes = Math.min(data.bytes, 256 * 1024);
  if (!metadata && data.truncated) {
    data = await readWindow(root, path);
    readBytes += Math.min(data.bytes, limit);
    metadata = metadataOf(data.text);
  }
  return { data, metadata, readBytes };
}
interface Located extends NativeSession {
  path: string;
  root: string;
  nativeId: string;
}

export class NativeHistoryReader {
  private cache = new Map<string, { time: number; value: NativeHistory; located: Located[] }>();
  constructor(
    private roots = {
      codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
      claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    },
  ) {}
  private async config(
    path: string,
    scope: NativeConfig['scope'],
    instruction = false,
  ): Promise<NativeConfig> {
    try {
      const data = await readWindow(dirname(path), path, false, 64 * 1024);
      if (instruction)
        return {
          path,
          scope,
          state: 'available',
          content: redact(data.text) as string,
          truncated: data.truncated,
        };
      let keys: string[];
      if (path.endsWith('.json')) keys = Object.keys(JSON.parse(data.text));
      else keys = [...data.text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]);
      return {
        path,
        scope,
        state: 'available',
        keys: [...new Set(keys)].slice(0, 100),
        truncated: data.truncated,
      };
    } catch (error) {
      return { path, scope, state: state(error) };
    }
  }
  private async configs(project: string) {
    const result: NativeConfig[] = [];
    for (const [path, instruction] of [
      [join(this.roots.codex, 'config.toml'), false],
      [join(this.roots.codex, 'AGENTS.md'), true],
      [join(this.roots.codex, 'AGENTS.override.md'), true],
      [join(this.roots.claude, 'settings.json'), false],
      [join(this.roots.claude, 'CLAUDE.md'), true],
    ] as const)
      result.push(await this.config(path, 'global', instruction));
    const parents: string[] = [];
    let current = dirname(project);
    while (current !== dirname(current) && parents.length < 30) {
      parents.push(current);
      current = dirname(current);
    }
    for (const parent of parents.reverse()) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md']) {
        const config = await this.config(join(parent, name), 'ancestor', true);
        if (config.state !== 'missing') result.push(config);
      }
    }
    for (const [name, instruction] of [
      ['AGENTS.md', true],
      ['AGENTS.override.md', true],
      ['CLAUDE.md', true],
      ['.claude/CLAUDE.md', true],
      ['.codex/config.toml', false],
      ['.claude/settings.json', false],
      ['.claude/settings.local.json', false],
    ] as const)
      result.push(await this.config(join(project, name), 'project', instruction));
    return result;
  }
  async scan(projectInput: string, refresh = false): Promise<NativeHistory> {
    const project = await localFolder(projectInput);
    const cached = this.cache.get(project);
    if (!refresh && cached && Date.now() - cached.time < 15000) return cached.value;
    let scannedBytes = 0;
    const located: Located[] = [],
      sources: NativeHistory['sources'] = [];
    for (const provider of ['codex', 'claude'] as const) {
      const roots = provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects'];
      for (const folder of roots) {
        const root = resolve(this.roots[provider], folder);
        const source: NativeHistory['sources'][number] = {
          provider,
          path: root,
          state: 'available',
          skipped: 0,
        };
        sources.push(source);
        let seen = 0;
        const walk = async (path: string, depth: number): Promise<void> => {
          if (seen >= 10000 || scannedBytes >= 64 * limit) {
            source.state = 'partial';
            return;
          }
          let entries;
          try {
            entries = await readdir(path, { withFileTypes: true });
          } catch (error) {
            source.state = path === root ? state(error) : 'partial';
            if (path !== root) source.skipped++;
            return;
          }
          for (const entry of entries) {
            if (++seen > 10000 || scannedBytes >= 64 * limit) {
              source.state = 'partial';
              break;
            }
            const file = join(path, entry.name);
            if (entry.isDirectory() && depth < (provider === 'codex' ? 4 : 1)) {
              await walk(file, depth + 1);
              continue;
            }
            if (entry.isSymbolicLink()) {
              source.skipped++;
              source.state = 'partial';
              continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            try {
              const { data, metadata, readBytes } = await metadataWindow(root, file, provider);
              scannedBytes += readBytes;
              if (!metadata || typeof metadata.cwd !== 'string') {
                source.skipped++;
                source.state = 'partial';
                continue;
              }
              if (!(await matches(metadata.cwd, project))) continue;
              const nativeId = provider === 'codex' ? metadata.id : metadata.sessionId;
              if (typeof nativeId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(nativeId)) {
                source.skipped++;
                source.state = 'partial';
                continue;
              }
              located.push({
                id: createHash('sha256')
                  .update(provider + ':' + file)
                  .digest('hex'),
                provider,
                cwd: metadata.cwd,
                modifiedAt: data.modifiedAt,
                bytes: data.bytes,
                nativeId,
                providerSessionId: nativeId,
                path: file,
                root,
              });
            } catch {
              source.skipped++;
              source.state = 'partial';
            }
          }
        };
        await walk(root, 0);
      }
    }
    // Recent Codex versions also keep threads in state_N.sqlite. Read only known
    // columns, tolerate older schemas, and report indexed histories that cannot be read.
    try {
      const databases = (await readdir(this.roots.codex))
        .filter((n) => /^state_\d+\.sqlite$/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of databases.slice(0, 1)) {
        const path = join(this.roots.codex, name);
        const source: NativeHistory['sources'][number] = {
          provider: 'codex',
          path,
          state: 'available',
          skipped: 0,
        };
        sources.push(source);
        let db: DatabaseSync | undefined;
        try {
          if ((await realpath(path)) !== resolve(path)) throw new Error('Symlink index');
          db = new DatabaseSync(path, { readOnly: true });
          db.exec('PRAGMA busy_timeout=1000');
          const rows = db
            .prepare('SELECT id,cwd,rollout_path,title FROM threads LIMIT 10001')
            .all();
          if (rows.length > 10000) source.state = 'partial';
          for (const row of rows.slice(0, 10000)) {
            if (!(await matches(row.cwd, project))) continue;
            const existing = located.find((s) => s.provider === 'codex' && s.nativeId === row.id);
            if (existing) {
              if (typeof row.title === 'string')
                existing.title = (redact(row.title) as string).slice(0, 160);
            } else {
              source.state = 'partial';
              source.skipped++;
            }
          }
        } catch {
          source.state = 'unreadable';
        } finally {
          db?.close();
        }
      }
    } catch {
      /* Directory source above reports missing/unreadable tool homes. */
    }
    located.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    if (located.length > 300)
      sources.forEach((s) => {
        if (s.state === 'available') s.state = 'partial';
      });
    const value: NativeHistory = {
      projectPath: project,
      configs: await this.configs(project),
      sources,
      sessions: located
        .slice(0, 300)
        .map(({ id, provider, cwd, modifiedAt, bytes, providerSessionId, title }) => ({
          id,
          provider,
          cwd,
          modifiedAt,
          bytes,
          providerSessionId,
          title,
        })),
    };
    if (this.cache.size > 30) this.cache.clear();
    this.cache.set(project, { time: Date.now(), value, located: located.slice(0, 300) });
    return value;
  }
  async output(projectInput: string, id: string): Promise<NativeOutput> {
    const project = await localFolder(projectInput);
    await this.scan(project);
    const session = this.cache.get(project)?.located.find((s) => s.id === id);
    if (!session) throw new Error('Local session not found for this project');
    const { metadata } = await metadataWindow(session.root, session.path, session.provider);
    if (
      !(await matches(metadata?.cwd, project)) ||
      (session.provider === 'codex' ? metadata?.id : metadata?.sessionId) !== session.nativeId
    )
      throw new Error('Local session no longer matches this project');
    const data = await readWindow(session.root, session.path, true);
    const parsed = records(data.text),
      entries: NativeOutput['entries'] = [];
    let clipped = false;
    for (const record of parsed.values) {
      if (session.provider === 'claude' && record.sessionId !== session.nativeId) continue;
      const message =
        session.provider === 'codex'
          ? record.type === 'response_item'
            ? record.payload
            : null
          : ['user', 'assistant'].includes(String(record.type))
            ? record.message
            : null;
      if (!message || typeof message !== 'object') continue;
      const m = message as { role?: string; content?: unknown };
      const role = session.provider === 'codex' ? m.role : String(record.type);
      if (!role || !['user', 'assistant'].includes(role)) continue;
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .flatMap((b) => {
                  if (!b || typeof b !== 'object') return [];
                  if (
                    ['text', 'input_text', 'output_text'].includes(b.type) &&
                    typeof b.text === 'string'
                  )
                    return [b.text];
                  if (b.type === 'tool_use' && typeof b.name === 'string')
                    return [`[Tool: ${b.name}]`];
                  return [];
                })
                .join('\n')
            : '';
      if (text) {
        if (text.length > 32000) clipped = true;
        entries.push({
          role,
          text: (redact(text) as string).slice(0, 32000),
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        });
      }
    }
    return {
      entries: entries.slice(-200),
      truncated: data.truncated || clipped || entries.length > 200,
      skipped: parsed.skipped,
    };
  }
}

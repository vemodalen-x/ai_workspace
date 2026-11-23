import { readdir, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  limit,
  metadataWindow,
  readWindow,
  records,
  sessionTranscript,
  sourceState,
} from './native-history.ts';
import { injected, textContent } from './history-task-tree.ts';
import { openTranscripts } from './process-probe.ts';
import { redact } from '../agent-adapters/process.ts';
import {
  buildMonitorOverview,
  monitorLimits,
  type IndexedSession,
  type MonitorOverview,
  type MonitorSource,
  type MonitorState,
  type SessionClient,
  type SessionPhase,
} from '../shared/monitoring.ts';
import type { NativeOutput, NativeProvider } from '../shared/native-history.ts';

const tailWindow = 256 * 1024;
const idPattern = /^[a-zA-Z0-9-]{1,100}$/;
const clip = (text: string, max: number) => {
  const value = (redact(text.replace(/\s+/g, ' ').trim()) as string).slice(0, max);
  return value || undefined;
};
const iso = (value: unknown) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
const detail = (value: unknown) =>
  typeof value === 'string' && /^[\w .:@/-]{1,80}$/.test(value) ? value : undefined;

function codexClient(meta: Record<string, unknown>) {
  const originator = typeof meta.originator === 'string' ? meta.originator : '';
  const source = meta.source;
  const spawn = (source as { subagent?: { thread_spawn?: Record<string, unknown> } } | null)
    ?.subagent?.thread_spawn;
  if (spawn)
    return {
      client: 'subagent' as const,
      clientDetail: detail(spawn.agent_nickname) ?? detail(spawn.agent_role),
      parentSessionId:
        typeof spawn.parent_thread_id === 'string' && idPattern.test(spawn.parent_thread_id)
          ? spawn.parent_thread_id
          : undefined,
    };
  // IDE plugins reuse the app-server protocol and may report source=vscode; the originator wins.
  const client: SessionClient = /intellij|jetbrains|pycharm|idea|webstorm|goland/i.test(originator)
    ? 'jetbrains'
    : /vscode|cursor|windsurf/i.test(originator) || source === 'vscode'
      ? 'vscode'
      : /sdk/i.test(originator)
        ? 'sdk'
        : source === 'exec'
          ? 'exec'
          : source === 'cli' || /cli/i.test(originator)
            ? 'cli'
            : 'unknown';
  return { client, clientDetail: detail(originator) };
}
function claudeClient(entrypoint: unknown) {
  const value = typeof entrypoint === 'string' ? entrypoint : '';
  const client: SessionClient =
    value === 'cli'
      ? 'cli'
      : /vscode|cursor/i.test(value)
        ? 'vscode'
        : /jetbrains|intellij|pycharm/i.test(value)
          ? 'jetbrains'
          : /sdk/i.test(value)
            ? 'sdk'
            : 'unknown';
  return { client, clientDetail: detail(value) };
}

interface Parsed {
  session: IndexedSession;
  root: string;
  path: string;
}
interface Progress {
  phase: SessionPhase;
  phaseAt?: string;
  lastRequest: string;
  lastEventAt?: string;
  errors: number;
  entrypoint?: string;
}
/** Resume point for one transcript: later refreshes only read bytes appended after `offset`. */
export interface SessionCursor {
  parsed: Parsed;
  progress: Progress;
  /** Byte offset after the last complete line, so unfinished writes are re-read later. */
  offset: number;
  dev: number;
  ino: number;
  head: string;
}
const appendLimit = 8 * limit;
const recentWindow = 4 * limit;
const own = (provider: NativeProvider, nativeId: string, r: Record<string, unknown>) =>
  provider === 'codex' ||
  (r.sessionId === nativeId &&
    !r.isSidechain &&
    !r.isMeta &&
    // Compaction summaries are written as user records but do not start a turn.
    !r.isCompactSummary &&
    !r.isVisibleInTranscriptOnly);
// Slash commands and `!` shell input are recorded as user text without a model turn.
const localCommand =
  /^<(?:command-(?:name|message|args)|local-command-|bash-(?:input|stdout|stderr))/;
function requestOf(provider: NativeProvider, nativeId: string, r: Record<string, unknown>) {
  if (!own(provider, nativeId, r)) return '';
  if (provider === 'codex') {
    const p = r.payload as { role?: string; content?: unknown } | undefined;
    return r.type === 'response_item' && p?.role === 'user' ? textContent(p.content, true) : '';
  }
  const m = r.message as { content?: unknown } | undefined;
  const text = r.type === 'user' ? textContent(m?.content, true) : '';
  return text &&
    !injected(text) &&
    !localCommand.test(text) &&
    !text.startsWith('[Request interrupted')
    ? text
    : '';
}
/** Fold records into the turn state. Full and appended reads use the same rules. */
function apply(
  provider: NativeProvider,
  nativeId: string,
  values: Record<string, unknown>[],
  p: Progress,
) {
  const set = (next: SessionPhase, r: Record<string, unknown>) => {
    p.phase = next;
    p.phaseAt = iso(r.timestamp) ?? p.phaseAt;
  };
  for (const r of values) {
    p.lastEventAt = iso(r.timestamp) ?? p.lastEventAt;
    const request = requestOf(provider, nativeId, r);
    if (request) p.lastRequest = request;
    if (provider === 'codex') {
      if (r.type !== 'event_msg') continue;
      const type = (r.payload as { type?: unknown } | undefined)?.type;
      if (type === 'task_started') set('working', r);
      else if (type === 'task_complete') set('waiting', r);
      else if (type === 'turn_aborted') set('aborted', r);
      else if (type === 'error' || type === 'stream_error') {
        p.errors++;
        set('error', r);
      }
      continue;
    }
    if (!own(provider, nativeId, r)) continue;
    if (typeof r.entrypoint === 'string') p.entrypoint ??= r.entrypoint;
    if (r.type === 'assistant') {
      const stop = (r.message as { stop_reason?: unknown } | undefined)?.stop_reason;
      if (r.isApiErrorMessage || stop === 'refusal') {
        p.errors++;
        set('error', r);
      } else if (stop === 'end_turn' || stop === 'stop_sequence') set('waiting', r);
      else if (stop === 'tool_use' || stop === 'max_tokens') set('working', r);
    } else if (r.type === 'user') {
      const text = textContent((r.message as { content?: unknown } | undefined)?.content);
      if (text.startsWith('[Request interrupted')) set('aborted', r);
      else if (!localCommand.test(text.trimStart())) set('working', r);
    } else if (r.type === 'system' && r.level === 'error') {
      p.errors++;
      set('error', r);
    }
  }
}
/** Leading bytes of a transcript; a different value means the path now holds another file. */
const fingerprint = async (root: string, path: string) => {
  // Up to the first newline, so a short file that is still growing keeps its fingerprint.
  const { text } = await readWindow(root, path, false, 256, 0);
  return text.includes('\n') ? text.slice(0, text.indexOf('\n')) : text;
};
const withProgress = (
  session: IndexedSession,
  p: Progress,
  data: { modifiedAt: string; bytes: number },
): IndexedSession => ({
  ...session,
  ...(session.provider === 'claude' ? claudeClient(p.entrypoint) : {}),
  lastRequest: p.lastRequest ? clip(p.lastRequest, 300) : undefined,
  lastEventAt: p.lastEventAt,
  modifiedAt: data.modifiedAt,
  bytes: data.bytes,
  phase: p.phase,
  phaseAt: p.phaseAt,
  errors: p.errors,
});

/**
 * Parse one transcript, or continue from `previous` when the same file only grew.
 * Reads are bounded windows opened read-only; nothing is written.
 */
export async function parseSession(
  provider: NativeProvider,
  root: string,
  path: string,
  archived: boolean,
  previous?: SessionCursor,
): Promise<{ cursor?: SessionCursor; bytesRead: number }> {
  if (previous) {
    const data = await readWindow(root, path, false, appendLimit, previous.offset);
    if (
      data.dev === previous.dev &&
      data.ino === previous.ino &&
      data.bytes >= previous.offset &&
      !data.truncated &&
      (await fingerprint(root, path)) === previous.head
    ) {
      const progress = { ...previous.progress };
      apply(
        provider,
        previous.parsed.session.providerSessionId,
        records(data.text).values,
        progress,
      );
      return {
        bytesRead: data.bytes - previous.offset,
        cursor: {
          ...previous,
          progress,
          offset: data.lineEnd,
          parsed: {
            ...previous.parsed,
            session: withProgress(previous.parsed.session, progress, data),
          },
        },
      };
    }
    // Replaced, rewritten, truncated or a very large append: rebuild from a fresh window.
  }
  const { data: head, metadata, readBytes } = await metadataWindow(root, path, provider);
  let bytesRead = readBytes;
  if (!metadata || typeof metadata.cwd !== 'string') return { bytesRead };
  const nativeId = provider === 'codex' ? metadata.id : metadata.sessionId;
  if (typeof nativeId !== 'string' || !idPattern.test(nativeId)) return { bytesRead };
  // A long-running turn can push its start marker far back; read more of recent files.
  const window =
    Date.now() - Date.parse(head.modifiedAt) <= monitorLimits.recentMs ? recentWindow : tailWindow;
  const tail = head.truncated ? await readWindow(root, path, true, window) : head;
  if (tail !== head) bytesRead += Math.min(tail.bytes, window);
  const headRecords = records(head.text).values;
  let firstRequest = '';
  for (const r of headRecords) if ((firstRequest = requestOf(provider, nativeId, r))) break;
  const progress: Progress = { phase: 'unknown', lastRequest: '', errors: 0 };
  for (const r of headRecords)
    if (typeof r.entrypoint === 'string' && own(provider, nativeId, r))
      progress.entrypoint ??= r.entrypoint;
  apply(provider, nativeId, tail === head ? headRecords : records(tail.text).values, progress);
  const session: IndexedSession = {
    id: createHash('sha256')
      .update(provider + ':' + path)
      .digest('hex'),
    provider,
    providerSessionId: nativeId,
    cwd: metadata.cwd,
    ...(provider === 'codex' ? codexClient(metadata) : { client: 'unknown' }),
    title: firstRequest ? clip(firstRequest, 160) : undefined,
    startedAt: iso(metadata.timestamp) ?? iso(headRecords[0]?.timestamp),
    modifiedAt: tail.modifiedAt,
    bytes: tail.bytes,
    phase: 'unknown',
    errors: 0,
    archived,
  };
  return {
    bytesRead,
    cursor: {
      parsed: { root, path, session: withProgress(session, progress, tail) },
      progress,
      offset: tail.lineEnd,
      dev: tail.dev,
      ino: tail.ino,
      head: await fingerprint(root, path),
    },
  };
}

interface Entry {
  key: string;
  cursor?: SessionCursor;
  /** Resolved path, compared with the targets of open file descriptors. */
  real: string;
}
interface Options {
  /** Bytes that may be read per refresh before remaining changed files wait for the next one. */
  budget: number;
  maxFiles: number;
  maxAgeMs: number;
  /** Transcripts held open by agent processes, or undefined when this cannot be observed. */
  probe: () => Promise<Set<string> | undefined>;
}

/**
 * Process-local, rebuildable index of native Codex / Claude Code transcripts from any client
 * (terminal CLI, VS Code or JetBrains plugins, SDK). It only opens tool homes read-only,
 * keeps nothing on disk and never controls those processes.
 */
export class SessionIndex {
  private entries = new Map<string, Entry>();
  private titles = new Map<string, string>();
  private sources: MonitorSource[] = [];
  private open?: Set<string>;
  private scannedAt?: string;
  private running?: Promise<void>;
  private options: Options;
  constructor(
    private roots = {
      codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
      claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    },
    options: Partial<Options> = {},
  ) {
    this.options = {
      budget: 96 * limit,
      maxFiles: 10000,
      maxAgeMs: 15000,
      probe: () => openTranscripts(),
      ...options,
    };
  }
  /** Single-flight refresh; concurrent callers share one scan. */
  refresh(): Promise<void> {
    return (this.running ??= this.scan().finally(() => {
      this.running = undefined;
    }));
  }
  get lastScan() {
    return this.scannedAt;
  }
  private async scan() {
    let budget = this.options.budget;
    const present = new Set<string>(),
      incomplete: string[] = [],
      sources: MonitorSource[] = [],
      changed: {
        source: MonitorSource;
        root: string;
        real: string;
        path: string;
        key: string;
        mtimeMs: number;
        archived: boolean;
      }[] = [];
    // Snapshot processes before reading files: a process that exits during the scan still
    // counts as attached once, and a session it opens afterwards is still recently written.
    const open = await this.options.probe().catch(() => undefined);
    for (const [provider, folder, depth] of [
      ['codex', 'sessions', 4],
      ['codex', 'archived_sessions', 4],
      ['claude', 'projects', 1],
    ] as const) {
      const root = resolve(this.roots[provider], folder);
      const source: MonitorSource = {
        provider,
        path: root,
        state: 'available',
        files: 0,
        skipped: 0,
        pending: 0,
      };
      sources.push(source);
      const degrade = () => {
        if (source.state === 'available') source.state = 'partial';
      };
      try {
        if (!(await lstat(root)).isDirectory()) throw Object.assign(new Error(), { code: 'EPERM' });
      } catch (error) {
        source.state = sourceState(error);
        // Keep earlier results only while a root is unreadable; a removed root clears them.
        if (source.state !== 'missing') incomplete.push(root);
        continue;
      }
      let seen = 0;
      const real = await realpath(root).catch(() => root);
      const walk = async (dir: string, level: number): Promise<void> => {
        let items;
        try {
          // Date folders and rollout names sort chronologically: walk newest first so the
          // per-source entry limit drops the oldest history.
          items = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
            b.name.localeCompare(a.name),
          );
        } catch {
          source.skipped++;
          degrade();
          incomplete.push(dir);
          return;
        }
        for (const item of items) {
          if (++seen > this.options.maxFiles) {
            degrade();
            incomplete.push(dir);
            return;
          }
          const path = join(dir, item.name);
          if (item.isSymbolicLink()) {
            source.skipped++;
            degrade();
            continue;
          }
          if (item.isDirectory()) {
            if (level < depth) await walk(path, level + 1);
            continue;
          }
          if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
          source.files++;
          present.add(path);
          let key: string, mtimeMs: number;
          try {
            const info = await lstat(path);
            key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
            mtimeMs = info.mtimeMs;
          } catch {
            source.skipped++;
            degrade();
            continue;
          }
          const previous = this.entries.get(path);
          if (previous?.key === key) {
            if (!previous.cursor) source.skipped++;
            continue;
          }
          changed.push({
            source,
            root,
            real,
            path,
            key,
            mtimeMs,
            archived: folder === 'archived_sessions',
          });
        }
      };
      await walk(root, 0);
    }
    // Newest first, so live sessions are never starved by a cold scan of old history. Files
    // left over when the byte budget runs out are pending, not missing: they keep any
    // previous result and are read on the next refresh.
    changed.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    for (const file of changed) {
      const { source, root, path } = file;
      if (budget <= 0) {
        source.pending++;
        continue;
      }
      const previous = this.entries.get(path);
      try {
        const { cursor, bytesRead } = await parseSession(
          source.provider,
          root,
          path,
          file.archived,
          previous?.cursor,
        );
        budget -= bytesRead;
        this.entries.set(path, {
          key: file.key,
          cursor,
          real: file.real + path.slice(root.length),
        });
        if (!cursor) source.skipped++;
      } catch {
        this.entries.delete(path);
        source.skipped++;
        if (source.state === 'available') source.state = 'partial';
      }
    }
    for (const path of this.entries.keys())
      if (!present.has(path) && !incomplete.some((dir) => path.startsWith(dir + '/')))
        this.entries.delete(path);
    sources.push(...(await this.readTitles()));
    this.sources = sources;
    this.open = open;
    this.scannedAt = new Date().toISOString();
  }
  // Codex keeps edited thread titles in state_N.sqlite. Read known columns only.
  private async readTitles(): Promise<MonitorSource[]> {
    let names: string[];
    try {
      names = (await readdir(this.roots.codex))
        .filter((n) => /^state_\d+\.sqlite$/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      return [];
    }
    if (!names.length) return [];
    const path = join(this.roots.codex, names[0]);
    const source: MonitorSource = {
      provider: 'codex',
      path,
      state: 'available',
      files: 1,
      skipped: 0,
      pending: 0,
    };
    let db: DatabaseSync | undefined;
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Symlink index');
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1000');
      const titles = new Map<string, string>();
      for (const row of db.prepare('SELECT id,title FROM threads LIMIT 20000').all())
        if (typeof row.id === 'string' && typeof row.title === 'string' && row.title.trim())
          titles.set(row.id, clip(row.title, 160) ?? '');
      this.titles = titles;
    } catch {
      source.state = 'unreadable';
    } finally {
      db?.close();
    }
    return [source];
  }
  private async canonical(path: string, cache: Map<string, string | undefined>) {
    if (!cache.has(path))
      cache.set(
        path,
        await realpath(path).catch(() =>
          path.startsWith('/') || /^[A-Za-z]:\\/.test(path) ? resolve(path) : undefined,
        ),
      );
    return cache.get(path);
  }
  async sessions(): Promise<IndexedSession[]> {
    const cache = new Map<string, string | undefined>();
    const result: IndexedSession[] = [];
    for (const { cursor, real } of this.entries.values()) {
      if (!cursor) continue;
      const s = cursor.parsed.session;
      const title = s.provider === 'codex' ? this.titles.get(s.providerSessionId) : undefined;
      // Claude Code does not keep its transcript open, so only Codex sessions are classified.
      const process =
        s.provider === 'codex' && this.open
          ? this.open.has(real)
            ? ('attached' as const)
            : ('detached' as const)
          : undefined;
      result.push({
        ...s,
        process,
        title: title || s.title,
        canonicalCwd: await this.canonical(s.cwd, cache),
      });
    }
    return result;
  }
  async overview(
    state: MonitorState,
    { refresh = false, clock }: { refresh?: boolean; clock?: Date } = {},
  ): Promise<MonitorOverview> {
    const age = this.scannedAt ? Date.now() - Date.parse(this.scannedAt) : Infinity;
    if (refresh || age > this.options.maxAgeMs) await this.refresh();
    const cache = new Map<string, string | undefined>();
    const projectPaths: Record<string, string> = {},
      workspacePaths: Record<string, string> = {};
    for (const p of state.projects) {
      const path = await this.canonical(p.repoPath, cache);
      if (path) projectPaths[p.id] = path;
    }
    for (const w of state.workspaces) {
      const path = await this.canonical(w.path, cache);
      if (path) workspacePaths[path] = w.id;
    }
    return buildMonitorOverview({
      state,
      sessions: await this.sessions(),
      sources: this.sources,
      scannedAt: this.scannedAt,
      processesObserved: !!this.open,
      projectPaths,
      workspacePaths,
      clock,
    });
  }
  /** Transcript tail for an indexed session; the file identity is re-checked before reading. */
  async output(id: string): Promise<NativeOutput> {
    if (!this.scannedAt) await this.refresh();
    const parsed = [...this.entries.values()].find((e) => e.cursor?.parsed.session.id === id)
      ?.cursor?.parsed;
    if (!parsed) throw new Error('Monitored session not found');
    const { provider, providerSessionId } = parsed.session;
    const { metadata } = await metadataWindow(parsed.root, parsed.path, provider);
    if ((provider === 'codex' ? metadata?.id : metadata?.sessionId) !== providerSessionId)
      throw new Error('Monitored session changed; refresh the monitor');
    return sessionTranscript({ ...parsed, provider, nativeId: providerSessionId });
  }
}

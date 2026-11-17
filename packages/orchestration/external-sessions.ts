import { constants } from 'node:fs';
import { open, readdir, realpath, stat as pathStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.ts';
import type { ExternalSession, ExternalSessionOutput } from '../shared/external-sessions.ts';
import { redact } from '../agent-adapters/process.ts';

export const externalSessionInput = z.object({ providerSessionId: z.string().uuid() }).strict();
const windowBytes = 1024 * 1024;
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
    !isAbsolute(rel)
  );
};

// Only direct UUID.jsonl files under Claude's own project directories are eligible.
// A request cannot supply a source path; symlinks are checked on every read.
export class ExternalSessions {
  constructor(
    private store: Store,
    private root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  ) {}

  list(projectId: string) {
    this.store.get('projects', projectId);
    return this.store.all('externalSessions').filter((s) => s.projectId === projectId);
  }

  private async source(id: string) {
    const root = await realpath(this.root).catch(() => {
      throw new Error('Claude session directory not found');
    });
    const directories = await readdir(root, { withFileTypes: true });
    if (directories.length > 10000) throw new Error('Too many Claude project directories');
    const matches: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const file = join(root, directory.name, `${id}.jsonl`);
      try {
        const resolved = await realpath(file);
        if (!within(root, resolved) || resolved !== file)
          throw new Error('Session source symlinks are not supported');
        matches.push(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    if (matches.length !== 1)
      throw new Error(matches.length ? 'Ambiguous Claude session ID' : 'Claude session not found');
    return { root, path: matches[0] };
  }

  private async read(id: string) {
    const source = await this.source(id);
    const file = await open(
      source.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      // Recheck after opening to detect replaced paths; never follow outside the configured root.
      if ((await realpath(source.path)) !== source.path) throw new Error('Session source changed');
      const stat = await file.stat();
      const current = await pathStat(source.path);
      if (stat.dev !== current.dev || stat.ino !== current.ino)
        throw new Error('Session source changed');
      if (!stat.isFile()) throw new Error('Session source is not a regular file');
      const size = Math.min(stat.size, windowBytes),
        start = stat.size - size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      // The writer may still be appending this JSON record. Pick it up on the next poll.
      lines.pop();
      const records: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const line of lines) {
        try {
          if (line.length > 256 * 1024) {
            skipped++;
            continue;
          }
          const value = JSON.parse(line);
          if (value && typeof value === 'object' && value.sessionId === id) records.push(value);
        } catch {
          skipped++;
        }
      }
      return {
        records,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        truncated: start > 0,
        skipped,
      };
    } finally {
      await file.close();
    }
  }

  async attach(projectId: string, input: unknown): Promise<ExternalSession> {
    const { providerSessionId } = externalSessionInput.parse(input);
    const project = this.store.get('projects', projectId);
    if (project.archived) throw new Error('Project archived');
    const existing = this.list(projectId).find((s) => s.providerSessionId === providerSessionId);
    if (existing) return existing;
    const data = await this.read(providerSessionId);
    if (!data.records.length) throw new Error('No matching Claude session records found');
    const cwd = data.records.findLast((r) => typeof r.cwd === 'string')?.cwd;
    const session: ExternalSession = {
      id: randomUUID(),
      projectId,
      provider: 'claude',
      providerSessionId,
      sourceCwd: typeof cwd === 'string' ? cwd : '',
      attachedAt: new Date().toISOString(),
    };
    this.store.tx(() => {
      this.store.put('externalSessions', session);
      this.store.event(
        {
          type: 'ProjectChanged',
          data: { action: 'session-attached', externalSessionId: session.id },
        },
        { projectId },
      );
    });
    return session;
  }

  async output(id: string): Promise<ExternalSessionOutput> {
    const session = this.store.get('externalSessions', id);
    const data = await this.read(session.providerSessionId);
    const entries: ExternalSessionOutput['entries'] = [];
    let clipped = false;
    for (const record of data.records) {
      if (!['user', 'assistant'].includes(String(record.type))) continue;
      const message = record.message as { content?: unknown } | undefined;
      const content = message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .flatMap((block) => {
                  if (!block || typeof block !== 'object') return [];
                  if (block.type === 'text' && typeof block.text === 'string') return [block.text];
                  if (block.type === 'tool_use' && typeof block.name === 'string')
                    return [`[Tool: ${block.name}]`];
                  if (block.type === 'tool_result') return ['[Tool result]'];
                  return [];
                })
                .join('\n')
            : '';
      if (text.length > 32000) clipped = true;
      if (text)
        entries.push({
          role: String(record.type),
          text: (redact(text) as string).slice(0, 32000),
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        });
    }
    return {
      session,
      entries: entries.slice(-200),
      bytes: data.bytes,
      modifiedAt: data.modifiedAt,
      truncated: data.truncated || clipped || entries.length > 200,
      skipped: data.skipped,
    };
  }

  detach(id: string) {
    const session = this.store.get('externalSessions', id);
    this.store.tx(() => {
      this.store.delete('externalSessions', id);
      this.store.event(
        { type: 'ProjectChanged', data: { action: 'session-detached', externalSessionId: id } },
        { projectId: session.projectId },
      );
    });
  }
}

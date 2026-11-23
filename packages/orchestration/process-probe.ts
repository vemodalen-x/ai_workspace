import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const agentProcess = /^(codex|claude)/i;
const maxFds = 4096;

/**
 * Transcript files currently held open by the user's own Codex / Claude Code processes.
 *
 * Codex keeps a session's rollout file open while the session is loaded, so an open
 * descriptor shows that a process still owns the session. Only `/proc/<pid>/comm` and the
 * `fd` symlinks are read; processes are never signalled or attached to. Returns undefined
 * where `/proc` is unavailable (macOS, Windows), meaning "unknown" rather than "detached".
 */
export async function openTranscripts(proc = '/proc'): Promise<Set<string> | undefined> {
  if (proc === '/proc' && process.platform !== 'linux') return undefined;
  let pids: string[];
  try {
    pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  const open = new Set<string>();
  for (const pid of pids) {
    const dir = join(proc, pid);
    try {
      if (uid !== undefined && uid !== 0 && (await stat(dir)).uid !== uid) continue;
      if (!agentProcess.test((await readFile(join(dir, 'comm'), 'utf8')).trim())) continue;
      for (const fd of (await readdir(join(dir, 'fd'))).slice(0, maxFds)) {
        const target = await readlink(join(dir, 'fd', fd)).catch(() => '');
        // Deleted files read as "<path> (deleted)" and are ignored by the suffix check.
        if (target.endsWith('.jsonl')) open.add(target);
      }
    } catch {
      // The process exited or is not ours; skip it.
    }
  }
  return open;
}

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { git } from '../packages/git-manager/index.ts';
import type { Run } from '../packages/shared/index.ts';
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-test-')),
    repo = join(root, 'repo'),
    data = join(root, 'data');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await writeFile(join(repo, 'README.md'), '# Fixture\n');
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'Initial fixture',
  ]);
  const svc = new Orchestrator(data);
  const project = await svc.createProject({
    name: 'CV-Agent-Project',
    repoPath: repo,
    concurrency: 2,
  });
  return { root, repo, data, svc, project };
}
export const key = () => randomUUID();
export async function settle(svc: Orchestrator, ids: string[], ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await svc.tick();
    const runs = ids.map((id) => svc.store.get('runs', id));
    if (runs.every((r) => !['queued', 'starting', 'running'].includes(r.state))) {
      await Promise.allSettled([...svc.running.values()].map((h) => h.promise));
      return runs;
    }
    await wait(40);
  }
  throw new Error(
    `Timed out: ${ids.map((id) => JSON.stringify(svc.store.get('runs', id))).join(',')}`,
  );
}
export function lastRun(svc: Orchestrator, id: string): Run {
  return svc.store.get('runs', id);
}

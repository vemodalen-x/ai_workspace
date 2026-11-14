import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Orchestrator } from '../packages/orchestration/service.ts';
import { git } from '../packages/git-manager/index.ts';
const data = resolve(process.env.WORKSPACE_DATA_DIR ?? '.workspace');
if (existsSync(join(data, 'server.lock'))) throw new Error('Stop the server before seeding');
const repo = join(data, 'example-repository');
await mkdir(repo, { recursive: true });
if (!existsSync(join(repo, '.git'))) {
  await git(repo, ['init', '-b', 'main']);
  await writeFile(
    join(repo, 'README.md'),
    '# CV-Agent-Project\n\nExplicit Mock Agent acceptance fixture. No provider calls.\n',
  );
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Workspace Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'Initialize acceptance fixture',
  ]);
}
const svc = new Orchestrator(data);
try {
  if (svc.store.all('projects').some((p) => p.repoPath === repo)) {
    console.log('Example already exists; nothing changed.');
  } else {
    const p = await svc.createProject({ name: 'CV-Agent-Project', repoPath: repo, concurrency: 2 });
    const a = svc.saveTask(p.id, {
      title: 'Implement Backend API',
      description: 'Mock acceptance fixture: create the backend output.',
      criteria: 'Produce an isolated JSON output and a reviewable Git diff.',
    });
    const b = svc.saveTask(p.id, {
      title: 'Implement Frontend UI',
      description: 'Mock acceptance fixture: create the frontend output.',
      criteria: 'Produce a different JSON output in a separate worktree.',
    });
    svc.saveTask(p.id, {
      title: 'Run integration tests',
      description: '[validate] Read and validate both dependency outputs.',
      criteria: 'A validation-report.json with passed=true and two checked outputs.',
      dependencies: [a.id, b.id],
      integration: true,
      priority: 40,
    });
    svc.store.event({
      type: 'Log',
      data: {
        text: 'Mock acceptance project created. All three tasks use the clearly labeled Mock Agent. Real Codex/Claude must be selected and launched explicitly.',
      },
    });
    console.log(`Created CV-Agent-Project at ${repo}. Open the UI and queue draft tasks.`);
    if (process.argv.includes('--run')) {
      const ids = svc.store
        .all('tasks')
        .filter((t) => t.projectId === p.id)
        .map((t) => svc.enqueue(t.id, { requestKey: randomUUID() }).id);
      const { settle } = await import('../tests/helpers.ts');
      await settle(svc, ids);
      console.log(
        'Mock A/B/C execution completed. Review changes and approve integration in the UI.',
      );
    }
  }
} finally {
  await svc.shutdown();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { browseFolders, localFolder } from '../packages/orchestration/local-folders.ts';
import { createApp } from '../apps/server/src/app.ts';

test('loading folders is idempotent; removing registration preserves files, history and restoration', async () => {
  const { svc, repo, project } = await fixture();
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    const task = svc.saveTask(project.id, {
      title: 'Keep task',
      description: 'Original',
      criteria: 'Original',
    });
    svc.store.put('externalSessions', {
      id: 'attached',
      projectId: project.id,
      provider: 'claude',
      providerSessionId: 'original-session',
      sourceCwd: repo,
      attachedAt: new Date().toISOString(),
    });
    const before = await readFile(join(repo, 'README.md'), 'utf8');
    assert.equal(
      (await svc.createProject({ name: 'duplicate', repoPath: repo, concurrency: 2 })).id,
      project.id,
    );
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(svc.snapshot().projects.length, 0);
    assert.equal(svc.snapshot().tasks.length, 0);
    assert.equal(svc.store.get('tasks', task.id).title, 'Keep task');
    assert.equal(
      svc.store.get('externalSessions', 'attached').providerSessionId,
      'original-session',
    );
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), before);
    assert.equal(
      (await app.inject({ url: `/api/projects/${project.id}/local-history`, headers })).statusCode,
      404,
    );
    const restored = await svc.createProject({ name: 'again', repoPath: repo, concurrency: 2 });
    assert.equal(restored.id, project.id);
    assert.equal(svc.snapshot().tasks[0].id, task.id);
    svc.store.put('runs', {
      id: 'active',
      projectId: project.id,
      taskId: task.id,
      state: 'orphaned',
    } as never);
    assert.throws(() => svc.deleteProject(project.id), /Stop or reconcile/);
    assert.equal(svc.store.get('projects', project.id).removedAt, undefined);
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

test('folder loading and authenticated browsing validate paths, permissions and canonical aliases without creating Git', async () => {
  const { svc, root } = await fixture();
  const path = join(root, '已有 folder');
  await mkdir(path);
  await writeFile(join(path, 'keep.txt'), 'unchanged');
  const { app, token } = await createApp(svc, { serveWeb: false });
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (await app.inject({ url: '/api/local-folders', headers: { host: 'localhost' } })).statusCode,
      401,
    );
    const listing = await app.inject({
      url: '/api/local-folders?path=' + encodeURIComponent(root),
      headers,
    });
    assert.equal(listing.statusCode, 200);
    assert.ok(listing.json().folders.some((f: { path: string }) => f.path === path));
    const project = await svc.createProject({ name: 'Folder', repoPath: path, concurrency: 2 });
    assert.equal(project.executionReady, false);
    assert.throws(() => svc.saveTask(project.id, { title: 'No execution' }), /Git repository root/);
    await assert.rejects(readFile(join(path, '.git')), /ENOENT/);
    assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'unchanged');
    await assert.rejects(localFolder('relative'), /absolute/);
    await assert.rejects(localFolder(join(root, 'absent')), /not found/);
    await assert.rejects(localFolder(join(path, 'keep.txt')), /not a folder/);
    if (process.platform !== 'win32') {
      const alias = join(root, 'alias');
      await symlink(path, alias);
      assert.equal(
        (await svc.createProject({ name: 'Alias', repoPath: alias, concurrency: 2 })).id,
        project.id,
      );
      const denied = join(root, 'denied');
      await mkdir(denied);
      await chmod(denied, 0);
      try {
        if (process.getuid?.() !== 0)
          await assert.rejects(browseFolders(denied), /Permission denied/);
      } finally {
        await chmod(denied, 0o700);
      }
    }
  } finally {
    await app.close();
    await svc.shutdown();
  }
});

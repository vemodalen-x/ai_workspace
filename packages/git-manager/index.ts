import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import type { Workspace } from '../shared/index.ts';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  return (
    await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trim();
}
export function within(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
export class GitManager {
  constructor(public root: string) {}
  async repository(input: string) {
    const path = await realpath(input);
    const top = await git(path, ['rev-parse', '--show-toplevel']);
    if ((await realpath(top)) !== path)
      throw new Error('Import the repository root, not a subdirectory');
    await git(path, ['rev-parse', 'HEAD']);
    const branch = await git(path, ['symbolic-ref', '--short', 'HEAD']);
    return { path, branch };
  }
  async create(repo: string, id: string, base?: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid workspace id');
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, id),
      branch = `agent/${id}`;
    const baseCommit = base ?? (await git(repo, ['rev-parse', 'HEAD']));
    await git(repo, ['worktree', 'add', '-b', branch, path, baseCommit]);
    return { path, branch, baseCommit };
  }
  async assertOwned(repo: string, w: Workspace) {
    if (!within(this.root, w.path) || w.cleaned)
      throw new Error('Workspace is not managed or already cleaned');
    const listing = await git(repo, ['worktree', 'list', '--porcelain']);
    if (
      !listing.split('\n').includes(`worktree ${w.path.replaceAll('\\', '/')}`) &&
      !listing.split('\n').includes(`worktree ${w.path}`)
    )
      throw new Error('Workspace is not registered');
    const branch = await git(w.path, ['symbolic-ref', '--short', 'HEAD']);
    if (branch !== w.branch) throw new Error('Workspace branch changed externally');
  }
  async diff(w: Workspace) {
    const tracked = await git(w.path, ['diff', w.baseCommit, '--no-ext-diff', '--']);
    const untracked = await git(w.path, ['ls-files', '--others', '--exclude-standard']);
    return (
      tracked + (untracked ? `\nUntracked files (snapshot to include content):\n${untracked}` : '')
    );
  }
  async snapshot(repo: string, w: Workspace, message: string) {
    await this.assertOwned(repo, w);
    await git(w.path, ['add', '--all', '--', '.']);
    if (await git(w.path, ['status', '--porcelain']))
      await git(w.path, [
        '-c',
        'user.name=AI Agent Workspace',
        '-c',
        'user.email=workspace@localhost',
        'commit',
        '-m',
        message,
      ]);
    return git(w.path, ['rev-parse', 'HEAD']);
  }
  async integrate(w: Workspace, commits: string[]) {
    for (const sha of commits)
      await git(w.path, [
        '-c',
        'user.name=AI Agent Workspace',
        '-c',
        'user.email=workspace@localhost',
        'merge',
        '--no-edit',
        sha,
      ]);
  }
  async preview(repo: string, source: string) {
    const target = await git(repo, ['rev-parse', 'HEAD']);
    const targetBranch = await git(repo, ['symbolic-ref', '--short', 'HEAD']);
    if (await git(repo, ['status', '--porcelain']))
      throw new Error('Target repository has uncommitted changes');
    const tree = (await git(repo, ['merge-tree', '--write-tree', target, source])).split('\n')[0];
    const previewCommit = await git(repo, [
      '-c',
      'user.name=AI Agent Workspace',
      '-c',
      'user.email=workspace@localhost',
      'commit-tree',
      tree,
      '-p',
      target,
      '-p',
      source,
      '-m',
      'Integrate reviewed agent workspace',
    ]);
    return { target, targetBranch, previewCommit };
  }
  async containsCommit(repo: string, tip: string, commit: string) {
    try {
      await git(repo, ['merge-base', '--is-ancestor', commit, tip]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }
  async merge(
    repo: string,
    a: { source: string; target: string; targetBranch: string; previewCommit: string },
    branch: string,
  ) {
    if ((await git(repo, ['rev-parse', branch])) !== a.source)
      throw new Error('Source changed since preview');
    if (
      (await git(repo, ['rev-parse', 'HEAD'])) !== a.target ||
      (await git(repo, ['symbolic-ref', '--short', 'HEAD'])) !== a.targetBranch
    )
      throw new Error('Target changed since preview');
    if (await git(repo, ['status', '--porcelain']))
      throw new Error('Target has uncommitted changes');
    await git(repo, ['merge', '--ff-only', a.previewCommit]);
  }
  async cleanup(repo: string, w: Workspace) {
    await this.assertOwned(repo, w);
    if (await git(w.path, ['status', '--porcelain']))
      throw new Error('Refusing to delete uncommitted changes');
    await git(repo, [
      'worktree',
      'remove',
      w.path,
    ]); /* Branch deliberately retained as recovery anchor. */
  }
}

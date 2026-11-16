import { access, chmod, copyFile, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = resolve(process.argv[2] ?? 'artifacts/stage');
// A fresh stage prevents an older runtime, CLI or untracked files entering a release.
await mkdir(dirname(stage), { recursive: true });
await mkdir(stage);
const windows = process.platform === 'win32';
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const bundled = new Set<string>();

// Preserve npm's physical layout, including dependencies installed at different
// versions below a parent. Resolve from the importing package, as Node does.
async function copyDependency(name: string, importer: string, optional = false) {
  const paths =
    createRequire(join(importer, 'package.json')).resolve.paths(name + '/package.json') ?? [];
  const source = paths
    .map((p) => join(p, name))
    .find(
      (p) =>
        p.startsWith(join(root, 'node_modules') + (windows ? '\\' : '/')) &&
        existsSync(join(p, 'package.json')),
    );
  if (!source) {
    if (optional) return;
    throw new Error('Missing runtime dependency ' + name + ' from ' + importer);
  }
  if (bundled.has(source)) return;
  bundled.add(source);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await cp(source, join(stage, relative(root, source)), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => basename(p) !== 'node_modules',
  });
  for (const dep of new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]))
    await copyDependency(
      dep,
      source,
      Boolean(pkg.optionalDependencies?.[dep] || pkg.peerDependenciesMeta?.[dep]?.optional),
    );
}

for (const name of [
  'fastify',
  '@fastify/static',
  '@fastify/websocket',
  'systeminformation',
  'zod',
  '@openai/codex-sdk',
])
  await copyDependency(name, root);
await access(
  join(stage, 'node_modules/@openai/codex-' + process.platform + '-' + process.arch, 'vendor'),
);
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    { name: manifest.name, version: manifest.version, type: 'module', private: true },
    null,
    2,
  ) + '\n',
);
await mkdir(join(stage, 'runtime'));
const runtime = join(stage, 'runtime', windows ? 'node.exe' : 'node');
await copyFile(process.execPath, runtime);
await chmod(runtime, 0o755);
const bin = dirname(process.execPath);
const license = [
  join(bin, 'LICENSE'),
  join(dirname(bin), 'LICENSE'),
  join(dirname(bin), 'share/doc/node/LICENSE'),
].find(existsSync);
if (!license) throw new Error('The official Node distribution LICENSE must accompany the runtime.');
await copyFile(license, join(stage, 'runtime/LICENSE'));
await cp(join(root, 'dist'), join(stage, 'dist'), {
  recursive: true,
  filter: (p) => !p.endsWith('.map') && !p.endsWith('visual-review.html'),
});
await copyFile(join(root, 'docs/local-install.md'), join(stage, 'README.md'));
const command = windows ? 'ai-agent-workspace.cmd' : 'ai-agent-workspace';
await copyFile(join(root, 'packaging', command), join(stage, command));
if (!windows) await chmod(join(stage, command), 0o755);
await stat(join(stage, 'dist/web/index.html'));
await stat(join(stage, 'dist/launcher/src/index.js'));
console.log(
  'Staged ' +
    manifest.name +
    ' ' +
    manifest.version +
    ', Node ' +
    process.version +
    ', ' +
    bundled.size +
    ' runtime packages at ' +
    stage,
);

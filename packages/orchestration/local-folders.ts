import { constants } from 'node:fs';
import { access, realpath, stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, dirname, basename, join } from 'node:path';

export async function localFolder(input: string) {
  if (!isAbsolute(input)) throw new Error('Choose an absolute local folder path');
  try {
    const path = await realpath(input);
    if (!(await stat(path)).isDirectory()) throw new Error('The selected path is not a folder');
    await access(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new Error('Local folder not found', { cause: error });
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error('Permission denied reading local folder', { cause: error });
    throw error;
  }
}

export async function browseFolders(input = homedir()) {
  const path = await localFolder(input);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path,
      name: basename(path) || path,
      parent: dirname(path),
      folders: folders.slice(0, 300).map((e) => ({ name: e.name, path: join(path, e.name) })),
      truncated: folders.length > 300,
    };
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new Error('Permission denied reading local folder', { cause: error });
    throw error;
  }
}

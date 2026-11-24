import { useState } from 'react';
import { api } from './api.ts';
import { Field } from './UiPrimitives.tsx';
import { t, errorText } from './i18n.ts';
interface FolderListing {
  path: string;
  name: string;
  parent: string;
  folders: { name: string; path: string }[];
  truncated: boolean;
}
const folderName = (path: string) =>
  path.trim().split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 100) ?? '';
export function ProjectFolderForm({ initialPath = '' }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(() => folderName(initialPath));
  const [nameEdited, setNameEdited] = useState(false);
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  async function browse(target?: string) {
    setLoading(true);
    setError('');
    setListing(undefined);
    try {
      const data = await api<FolderListing>(
        '/local-folders' + (target ? '?path=' + encodeURIComponent(target) : ''),
      );
      setListing(data);
      setFilter('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <p className="form-hint">
        {t(
          'Load an existing folder without creating or changing its files. Local Codex and Claude Code records are discovered by their working directory.',
        )}
      </p>
      <label>
        {t('Project name')}
        <input
          name="name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(!!e.target.value);
          }}
        />
      </label>
      <label>
        {t('Repository path')}
        <input
          name="repoPath"
          required
          value={path}
          onChange={(e) => {
            const nextPath = e.target.value;
            setPath(nextPath);
            if (!nameEdited) setName(folderName(nextPath));
          }}
          placeholder="/home/you/projects/app"
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={loading}
        onClick={() => void browse(path || undefined)}
      >
        {t(loading ? 'Loading folders…' : 'Browse local folders')}
      </button>
      {error && <p role="alert">{errorText(error)}</p>}
      {listing && (
        <section className="folder-browser" aria-label={t('Local folders')}>
          <p className="form-hint">{t('Folders are on the machine running Workspace.')}</p>
          <code>{listing.path}</code>
          <div className="button-group">
            <button
              type="button"
              disabled={loading || listing.parent === listing.path}
              onClick={() => void browse(listing.parent)}
            >
              {t('Parent folder')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={loading}
              onClick={() => {
                setPath(listing.path);
                if (!nameEdited) setName(listing.name);
                setListing(undefined);
              }}
            >
              {t('Use this folder')}
            </button>
          </div>
          <label>
            {t('Filter folders')}
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </label>
          <div className="folder-list" aria-busy={loading}>
            {listing.folders
              .filter((folder) => folder.name.toLowerCase().includes(filter.trim().toLowerCase()))
              .map((folder) => (
                <button
                  type="button"
                  key={folder.path}
                  disabled={loading}
                  onClick={() => void browse(folder.path)}
                >
                  {folder.name}
                </button>
              ))}
          </div>
          {!listing.folders.length && <p>{t('No subfolders')}</p>}
          {!!listing.folders.length &&
            !listing.folders.some((folder) =>
              folder.name.toLowerCase().includes(filter.trim().toLowerCase()),
            ) && <p role="status">{t('No matching folders')}</p>}
          {listing.truncated && (
            <p>{t('Only the first 300 folders are shown. Enter a path to open another folder.')}</p>
          )}
        </section>
      )}
      <Field
        label={t('Concurrent sessions')}
        name="concurrency"
        type="number"
        value="2"
        min="1"
        max="32"
      />
      <p className="note">
        {t(
          'Loading never initializes Git or copies provider data. Task execution requires a Git repository root with an initial commit.',
        )}
      </p>
    </>
  );
}

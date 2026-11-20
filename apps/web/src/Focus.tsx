import { createEvidenceReader } from '../../../packages/shared/evidence.ts';
import { t as tr, uiMessage } from './i18n.ts';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Target, ShieldCheck } from 'lucide-react';
import type { Snapshot, Project, Provider } from '../../../packages/shared/index.ts';
import type { AttentionItem } from '../../../packages/shared/assistant.ts';
import { api } from './api.ts';
import { usePreference } from './preferences.ts';

export function Focus({
  data,
  search,
  open,
  refresh,
  notify,
  provider,
  importProject,
  openExperiments,
}: {
  data: Snapshot;
  search: string;
  open: (item: AttentionItem) => void;
  refresh: () => Promise<unknown>;
  notify: (text: string, error?: boolean) => void;
  provider: Provider;
  importProject: () => void;
  openExperiments: (projectId: string) => void;
}) {
  const [projectId, setProjectId] = usePreference('aw.focus.project', '');
  const [filter, setFilter] = usePreference('aw.focus.filter', 'all');
  const [busy, setBusy] = useState(false);
  const projects = data.projects.filter((p) => !p.archived);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const b = data.briefing;
  const evidence = createEvidenceReader(data);
  const reason = (item: AttentionItem) => {
    if (item.kind === 'stale') {
      const run = evidence.latestRun(item.taskId);
      if (run) return evidence.evidence(run).reasons.map(uiMessage).join(' ');
    }
    if (item.kind === 'waiting' && item.reason.startsWith('Waiting for: ')) {
      const task = data.tasks.find((task) => task.id === item.taskId);
      const dependencies = task?.dependencies
        .map((id) => data.tasks.find((task) => task.id === id))
        .filter((task) => !task || task.state !== 'completed');
      if (dependencies?.length)
        return tr('Waiting for: {dependencies}', {
          dependencies: dependencies
            .map((task) =>
              task ? `${task.title} (${uiMessage(task.state)})` : tr('missing dependency'),
            )
            .join(', '),
        });
    }
    return uiMessage(item.reason);
  };
  const visible = b.items.filter(
    (i) =>
      (filter === 'all' || i.kind === filter) &&
      `${i.title} ${reason(i)}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function capture(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!project || busy) return;
    const form = e.currentTarget;
    const title = String(new FormData(form).get('title') ?? '').trim();
    if (!title) return;
    setBusy(true);
    try {
      await api(`/projects/${project.id}/tasks`, 'POST', { title, provider });
      form.reset();
      await refresh();
      notify(tr('Captured as a draft. Clarify it before execution.'));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Target size={14} /> {tr('YOUR NEXT ACTION')}{' '}
          </div>
          <h1> {tr('Focus inbox')} </h1>
          <p> {tr('Decide what needs you. Let confirmed work run in the background.')} </p>
        </div>
        <span className="local-pill">
          {b.running} {tr('running')}{' '}
        </span>
      </div>
      <section className="surface focus-capture">
        {!project ? (
          <div className="section-heading">
            <div>
              <h2>{tr('Connect your first repository')}</h2>
              <p>
                {tr(
                  'Choose an existing local folder to view history, or a Git repository with an initial commit to run tasks.',
                )}
              </p>
            </div>
            <button className="primary" onClick={importProject}>
              {tr('Import project')}
            </button>
          </div>
        ) : (
          <>
            <form onSubmit={(e) => void capture(e)}>
              <label>
                {' '}
                {tr('Project')}{' '}
                <select
                  value={project?.id ?? ''}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={!projects.length}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="capture-title">
                {' '}
                {tr('Quick capture')}{' '}
                <input
                  name="title"
                  placeholder={tr('An outcome, question, or issue to work on…')}
                  maxLength={180}
                  required
                  disabled={!project}
                />
              </label>
              <button className="primary" disabled={!project || busy}>
                <Plus size={15} /> {tr('Capture draft')}{' '}
              </button>
            </form>
            <small>
              {tr(
                'Drafts wait for your review before execution. To run your own script, open command trials.',
              )}
            </small>
            <button className="text-button" onClick={() => openExperiments(project.id)}>
              {tr('Open command trials')}
            </button>
          </>
        )}
      </section>
      <div className="focus-review" aria-label={tr('Seven day review')}>
        <div>
          <strong>{b.review.completed}</strong>
          <span> {tr('Runs completed · 7 days')} </span>
        </div>
        <div>
          <strong>{b.review.commandPassed}</strong>
          <span> {tr('With command pass')} </span>
        </div>
        <div>
          <strong>{b.review.unverified}</strong>
          <span> {tr('No passing command')} </span>
        </div>
        <div>
          <strong>{b.review.failed}</strong>
          <span> {tr('Runs failed')} </span>
        </div>
      </div>
      <section className="surface focus-actions">
        <div className="section-heading">
          <h2>
            {' '}
            {tr('Attention queue')} <span>{b.items.length}</span>
          </h2>
          <label>
            {' '}
            {tr('Show')}{' '}
            <select
              aria-label={tr('Filter attention')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {[
                'all',
                'stale',
                'recover',
                'approve',
                'fix',
                'waiting',
                'clarify',
                'review',
                'ready',
              ].map((v) => (
                <option key={v} value={v}>
                  {uiMessage(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="focus-explanation">
          {' '}
          {tr(
            'Recovery first, then decisions and blockers. Within each group, higher task priority comes first. Suggestions do not execute work.',
          )}{' '}
        </p>
        {visible.map((i) => (
          <article key={i.id} className={`attention-row attention-${i.kind}`}>
            <span className="attention-kind">{uiMessage(i.kind)}</span>
            <div className="attention-body">
              <small>
                {data.projects.find((p) => p.id === i.projectId)?.name} {tr('· Priority')}{' '}
                {i.priority}
              </small>
              <h3>{i.title}</h3>
              <p>{reason(i)}</p>
            </div>
            <button className="secondary small" onClick={() => open(i)}>
              {uiMessage(i.action)}
              <ArrowRight size={14} />
            </button>
          </article>
        ))}
        {!visible.length && (
          <div className="focus-empty">
            <ShieldCheck size={24} />
            <p>
              {b.items.length
                ? tr('No items match this filter.')
                : tr('No decisions waiting. Capture your next outcome when ready.')}
            </p>
          </div>
        )}
      </section>
      {project && (
        <ProjectContext key={project.id} project={project} refresh={refresh} notify={notify} />
      )}
    </>
  );
}
function ProjectContext({
  project,
  refresh,
  notify,
}: {
  project: Project;
  refresh: () => Promise<unknown>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const context = String(new FormData(e.currentTarget).get('context') ?? '');
    try {
      await api(`/projects/${project.id}`, 'PATCH', { context });
      await refresh();
      notify(tr('Project context saved for future execution briefs.'));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="surface focus-context">
      <summary>
        {' '}
        {tr('Project context ·')} {project.name}
      </summary>
      <form onSubmit={(e) => void save(e)}>
        <label>
          {' '}
          {tr('Working agreements')}{' '}
          <textarea
            name="context"
            rows={5}
            maxLength={12000}
            defaultValue={project.context ?? ''}
            placeholder={tr(
              'Architecture decisions, coding conventions, scope boundaries, test instructions…',
            )}
          />
        </label>
        <p>
          {' '}
          {tr(
            'User-maintained context is sent to the selected provider with each run. Do not enter credentials. Changes affect future execution briefs only.',
          )}{' '}
        </p>
        <button className="secondary" disabled={busy}>
          {' '}
          {tr('Save project context')}{' '}
        </button>
      </form>
    </details>
  );
}

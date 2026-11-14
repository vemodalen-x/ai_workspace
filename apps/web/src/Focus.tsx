import { useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Target, ShieldCheck } from 'lucide-react';
import type { Snapshot, Project } from '../../../packages/shared/index.ts';
import type { AttentionItem } from '../../../packages/shared/assistant.ts';
import { api } from './api.ts';
import { usePreference } from './preferences.ts';

export function Focus({
  data,
  search,
  open,
  refresh,
  notify,
}: {
  data: Snapshot;
  search: string;
  open: (item: AttentionItem) => void;
  refresh: () => Promise<unknown>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [projectId, setProjectId] = usePreference('aw.focus.project', '');
  const [filter, setFilter] = usePreference('aw.focus.filter', 'all');
  const [busy, setBusy] = useState(false);
  const projects = data.projects.filter((p) => !p.archived);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const b = data.briefing;
  const visible = b.items.filter(
    (i) =>
      (filter === 'all' || i.kind === filter) &&
      `${i.title} ${i.reason}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function capture(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!project || busy) return;
    const form = e.currentTarget;
    const title = String(new FormData(form).get('title') ?? '').trim();
    if (!title) return;
    setBusy(true);
    try {
      await api(`/projects/${project.id}/tasks`, 'POST', { title });
      form.reset();
      await refresh();
      notify('Captured as a draft. Clarify it before execution.');
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
            <Target size={14} /> YOUR NEXT ACTION
          </div>
          <h1>Focus inbox</h1>
          <p>Decide what needs you. Let confirmed work run in the background.</p>
        </div>
        <span className="local-pill">{b.running} running</span>
      </div>
      <section className="surface focus-capture">
        <form onSubmit={(e) => void capture(e)}>
          <label>
            Project
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
            Quick capture
            <input
              name="title"
              placeholder="An outcome, question, or issue to work on…"
              maxLength={180}
              required
              disabled={!project}
            />
          </label>
          <button className="primary" disabled={!project || busy}>
            <Plus size={15} /> Capture draft
          </button>
        </form>
        <small>
          {project
            ? 'Capture creates a Mock draft only. It never starts an agent or consumes provider usage.'
            : 'Import a Git project from Overview to capture your first task.'}
        </small>
      </section>
      <div className="focus-review" aria-label="Seven day review">
        <div>
          <strong>{b.review.completed}</strong>
          <span>Runs completed · 7 days</span>
        </div>
        <div>
          <strong>{b.review.commandPassed}</strong>
          <span>With command pass</span>
        </div>
        <div>
          <strong>{b.review.unverified}</strong>
          <span>No passing command</span>
        </div>
        <div>
          <strong>{b.review.failed}</strong>
          <span>Runs failed</span>
        </div>
      </div>
      <section className="surface focus-actions">
        <div className="section-heading">
          <h2>
            Attention queue <span>{b.items.length}</span>
          </h2>
          <label>
            Show{' '}
            <select
              aria-label="Filter attention"
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
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="focus-explanation">
          Recovery first, then decisions and blockers. Within each group, higher task priority comes
          first. Suggestions do not execute work.
        </p>
        {visible.map((i) => (
          <article key={i.id} className={`attention-row attention-${i.kind}`}>
            <span className="attention-kind">{i.kind}</span>
            <div className="attention-body">
              <small>
                {data.projects.find((p) => p.id === i.projectId)?.name} · Priority {i.priority}
              </small>
              <h3>{i.title}</h3>
              <p>{i.reason}</p>
            </div>
            <button className="secondary small" onClick={() => open(i)}>
              {i.action}
              <ArrowRight size={14} />
            </button>
          </article>
        ))}
        {!visible.length && (
          <div className="focus-empty">
            <ShieldCheck size={24} />
            <p>
              {b.items.length
                ? 'No items match this filter.'
                : 'No decisions waiting. Capture your next outcome when ready.'}
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
      notify('Project context saved for future execution briefs.');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="surface focus-context">
      <summary>Project context · {project.name}</summary>
      <form onSubmit={(e) => void save(e)}>
        <label>
          Working agreements
          <textarea
            name="context"
            rows={5}
            maxLength={12000}
            defaultValue={project.context ?? ''}
            placeholder="Architecture decisions, coding conventions, scope boundaries, test instructions…"
          />
        </label>
        <p>
          User-maintained context is sent to the selected provider with each run. Do not enter
          credentials. Changes affect future execution briefs only.
        </p>
        <button className="secondary" disabled={busy}>
          Save project context
        </button>
      </form>
    </details>
  );
}

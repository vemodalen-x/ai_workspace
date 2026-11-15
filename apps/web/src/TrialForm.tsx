import { useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import type { Snapshot } from '../../../packages/shared/index.ts';
import type { Trial } from '../../../packages/shared/trials.ts';
import { api } from './api.ts';
import { ExperimentFields, readExperiment } from './ExperimentFields.tsx';
import { ModalFrame } from './UiPrimitives.tsx';

export function TrialForm({
  data,
  projectId,
  close,
  saved,
}: {
  data: Snapshot;
  projectId: string;
  close: () => void;
  saved: (trial: Trial) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [gpu, setGpu] = useState('');
  const projects = data.projects.filter((p) => !p.archived);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    try {
      let argv: unknown;
      try {
        argv = JSON.parse(String(f.get('argv')));
      } catch {
        throw new Error('Enter a JSON array of executable and arguments.');
      }
      const trial = await api<Trial>(`/projects/${f.get('project')}/trials`, 'POST', {
        title: f.get('title'),
        argv,
        experiment: readExperiment(f, true),
        allocation: {
          cpu: Number(f.get('cpu')),
          ramMb: Number(f.get('ram')),
          gpu: gpu || null,
          vramMb: gpu ? Number(f.get('vram')) : 0,
          timeoutSec: Number(f.get('timeout')),
        },
      });
      saved(trial);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalFrame title="New command trial" close={close}>
      <form onSubmit={submit}>
        <label>
          Project
          <select
            name="project"
            defaultValue={projects.some((p) => p.id === projectId) ? projectId : projects[0]?.id}
            required
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Trial name
          <input name="title" required maxLength={180} placeholder="Learning rate sweep" />
        </label>
        <label>
          Command (JSON argv)
          <textarea name="argv" rows={2} required placeholder={'["python", "train.py"]'} />
        </label>
        <ExperimentFields required />
        <details className="advanced">
          <summary>Local resource budget</summary>
          <div className="form-grid">
            <label>
              CPU cores
              <input type="number" name="cpu" min={1} defaultValue={1} required />
            </label>
            <label>
              RAM (MiB)
              <input type="number" name="ram" min={1} defaultValue={512} required />
            </label>
            <label>
              Local device
              <select value={gpu} onChange={(e) => setGpu(e.target.value)}>
                <option value="">CPU</option>
                {data.metrics.local?.gpus?.map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.index} · {g.name}
                  </option>
                ))}
              </select>
            </label>
            {gpu && (
              <label>
                GPU memory (MiB)
                <input type="number" name="vram" min={1} defaultValue={512} required />
              </label>
            )}
            <label>
              Timeout (seconds)
              <input type="number" name="timeout" min={1} max={86400} defaultValue={600} required />
            </label>
          </div>
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            <Save size={15} /> Save trial
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

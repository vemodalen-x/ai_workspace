import { useState } from 'react';
import type { Task } from '../../../packages/shared/index.ts';
export function readExperiment(form: FormData) {
  if (form.get('trackExperiment') !== 'on') return null;
  let parameters: unknown;
  try {
    parameters = JSON.parse(String(form.get('experimentParameters') || '{}'));
  } catch {
    throw new Error('Experiment parameters must be a JSON object, for example {"batchSize":8}.');
  }
  return {
    group: form.get('experimentGroup'),
    dataset: form.get('experimentDataset'),
    datasetVersion: form.get('experimentDatasetVersion'),
    seed: form.get('experimentSeed') ? Number(form.get('experimentSeed')) : null,
    parameters,
  };
}
export function ExperimentFields({
  experiment,
  initiallyEnabled = false,
}: {
  experiment: Task['experiment'];
  initiallyEnabled?: boolean;
}) {
  const [enabled, setEnabled] = useState(initiallyEnabled || Boolean(experiment));
  return (
    <section className="advanced">
      <label className="check-label">
        <input
          type="checkbox"
          name="trackExperiment"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Track as an AI experiment
      </label>
      {enabled && (
        <>
          <div className="form-grid">
            <label>
              Experiment group
              <input
                name="experimentGroup"
                required
                maxLength={120}
                placeholder="segmentation-ablation"
                defaultValue={experiment?.group}
              />
            </label>
            <label>
              Random seed
              <input
                name="experimentSeed"
                type="number"
                min={0}
                max={4294967295}
                step={1}
                defaultValue={experiment?.seed ?? ''}
              />
            </label>
            <label>
              Dataset
              <input
                name="experimentDataset"
                maxLength={500}
                defaultValue={experiment?.dataset}
                placeholder="Cityscapes val"
              />
            </label>
            <label>
              Dataset version / digest
              <input
                name="experimentDatasetVersion"
                maxLength={200}
                defaultValue={experiment?.datasetVersion}
                placeholder="Manifest SHA or immutable version"
              />
            </label>
          </div>
          <label>
            Experiment parameters (JSON object)
            <textarea
              name="experimentParameters"
              rows={3}
              defaultValue={JSON.stringify(experiment?.parameters ?? {}, null, 2)}
              placeholder={'{"lr":0.0001,"batchSize":8}'}
            />
          </label>
          <small>
            Settings are captured with the Run. Your training code must apply the seed and
            parameters.
          </small>
        </>
      )}
    </section>
  );
}

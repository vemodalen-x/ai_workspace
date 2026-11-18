import { t as tr } from './i18n.ts';
import { useState } from 'react';
import type { Task } from '../../../packages/shared/index.ts';
export function readExperiment(form: FormData, required = false) {
  if (!required && form.get('trackExperiment') !== 'on') return null;
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
  required = false,
}: {
  experiment?: Task['experiment'];
  initiallyEnabled?: boolean;
  required?: boolean;
}) {
  const [enabled, setEnabled] = useState(initiallyEnabled || Boolean(experiment));
  return (
    <section className="advanced">
      {!required && (
        <label className="check-label">
          <input
            type="checkbox"
            name="trackExperiment"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          {tr('Track as an AI experiment')}{' '}
        </label>
      )}
      {(enabled || required) && (
        <>
          <div className="form-grid">
            <label>
              {' '}
              {tr('Experiment group')}{' '}
              <input
                name="experimentGroup"
                required
                maxLength={120}
                placeholder="segmentation-ablation"
                defaultValue={experiment?.group}
              />
            </label>
            <label>
              {' '}
              {tr('Random seed')}{' '}
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
              {' '}
              {tr('Dataset')}{' '}
              <input
                name="experimentDataset"
                maxLength={500}
                defaultValue={experiment?.dataset}
                placeholder="Cityscapes val"
              />
            </label>
            <label>
              {' '}
              {tr('Dataset version / digest')}{' '}
              <input
                name="experimentDatasetVersion"
                maxLength={200}
                defaultValue={experiment?.datasetVersion}
                placeholder={tr('Manifest SHA or immutable version')}
              />
            </label>
          </div>
          <label>
            {' '}
            {tr('Experiment parameters (JSON object)')}{' '}
            <textarea
              name="experimentParameters"
              rows={3}
              defaultValue={JSON.stringify(experiment?.parameters ?? {}, null, 2)}
              placeholder={'{"lr":0.0001,"batchSize":8}'}
            />
          </label>
          <small>
            {' '}
            {tr(
              'Settings are captured with the Run. Your training code must apply the seed and parameters.',
            )}{' '}
          </small>
        </>
      )}
    </section>
  );
}

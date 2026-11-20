import { t as tr, uiMessage } from './i18n.ts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { Session, Task } from '../../../packages/shared/index.ts';
import type { ModelCatalog } from '../../../packages/shared/models.ts';

export function ModelSelector({
  provider,
  session,
}: {
  provider: Task['provider'];
  session?: Session;
}) {
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const catalog = useQuery({
    queryKey: ['models'],
    queryFn: () => api<ModelCatalog>('/models'),
    enabled: provider !== 'mock' && !session,
  });
  if (provider === 'mock') return null;
  if (session)
    return (
      <p className="form-hint">
        {' '}
        {tr('Continuing with model:')} {session.model ?? tr('provider default')}
        {session.reasoningEffort
          ? tr(' · reasoning: {effort}', { effort: session.reasoningEffort })
          : ''}{' '}
        {tr('. Start a new session to change these settings.')}{' '}
      </p>
    );
  const models = catalog.data?.[provider] ?? [];
  const efforts = models.find((option) => option.id === model)?.efforts ?? [];
  return (
    <>
      <label>
        {' '}
        {tr('Model')}{' '}
        <select
          aria-label={tr('Model')}
          name={model === '__custom' ? undefined : 'model'}
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
            setEffort('');
          }}
        >
          <option value=""> {tr('Provider default')} </option>
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value="__custom"> {tr('Custom model ID…')} </option>
        </select>
      </label>
      {model === '__custom' && (
        <label>
          {' '}
          {tr('Custom model ID')}{' '}
          <input
            aria-label={tr('Custom model ID')}
            name="model"
            required
            maxLength={200}
            placeholder={tr('Enter a model supported by your CLI/account')}
          />
        </label>
      )}
      {provider === 'codex' && (
        <label>
          {' '}
          {tr('Reasoning effort')}{' '}
          <select
            aria-label={tr('Reasoning effort')}
            name="reasoningEffort"
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
            disabled={!efforts.length}
          >
            <option value=""> {tr('Provider default')} </option>
            {efforts.map((value) => (
              <option key={value} value={value}>
                {uiMessage(value)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="form-hint">
        {provider === 'codex'
          ? catalog.isError || catalog.data?.codexSource === 'unavailable'
            ? tr('Model cache unavailable. Use provider default or a custom model ID.')
            : tr('Codex options come from the local CLI model cache.')
          : tr('Claude options are native CLI aliases; custom model IDs are also accepted.')}{' '}
        {tr(
          'Availability depends on the execution server and your account, and is checked when the run starts.',
        )}{' '}
      </p>
    </>
  );
}

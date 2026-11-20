import { z } from 'zod';

export const reasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export interface ModelOption {
  id: string;
  label: string;
  efforts: ReasoningEffort[];
}
export interface ModelCatalog {
  codex: ModelOption[];
  claude: ModelOption[];
  codexSource: 'local-cache' | 'unavailable';
}

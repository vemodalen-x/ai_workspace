import { z } from 'zod';
import { allocationSchema, experimentSchema, type RunState } from './index.ts';
import type { ExperimentMetric } from './experiment-results.ts';

export const trialInput = z
  .object({
    title: z.string().trim().min(1).max(180),
    argv: z
      .array(
        z
          .string()
          .max(4000)
          .refine((s) => !s.includes('\0')),
      )
      .min(1)
      .max(100)
      .refine((argv) => Boolean(argv[0]?.trim()), 'Executable is required'),
    experiment: experimentSchema.refine(
      (e) => JSON.stringify(e).length <= 6000,
      'Experiment metadata too large',
    ),
    allocation: allocationSchema,
  })
  .strict();

export interface Trial extends z.infer<typeof trialInput> {
  id: string;
  projectId: string;
  commit: string;
  createdAt: string;
}
export interface TrialAttempt {
  id: string;
  trialId: string;
  projectId: string;
  requestKey: string;
  state: Exclude<RunState, 'paused'>;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  gpu?: string | null;
  pid?: number;
  workspace?: string;
  exitCode?: number;
  reason?: string;
}
export interface AttemptOutput {
  log: string;
  logTruncated: boolean;
  metrics: ExperimentMetric[];
  ignored: number;
}

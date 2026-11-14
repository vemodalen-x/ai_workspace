import type { RunState } from '../shared/index.ts';
const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'cancelled', 'paused', 'failed'],
  starting: ['running', 'failed', 'cancelled', 'paused', 'orphaned'],
  running: ['completed', 'failed', 'cancelled', 'paused', 'orphaned'],
  orphaned: ['failed'],
  completed: [],
  failed: [],
  cancelled: [],
  paused: [],
};
export function assertTransition(from: RunState, to: RunState) {
  if (!transitions[from].includes(to)) throw new Error(`Invalid run transition: ${from} -> ${to}`);
}

import os from 'node:os';
import { taskInput, type RunManifest, type Task, type Snapshot } from '../shared/index.ts';
import { latestRun, freshness } from '../shared/evidence.ts';

export function captureManifest(state: Snapshot, task: Task): RunManifest {
  const project = state.projects.find((p) => p.id === task.projectId)!;
  const dependencies = task.dependencies.map((taskId) => {
    const run = latestRun(state, taskId);
    if (
      !run ||
      run.state !== 'completed' ||
      !run.resultCommit ||
      freshness(state, run).freshness !== 'current'
    )
      throw new Error(
        'Dependency evidence is stale or unavailable; rerun dependencies before execution',
      );
    return { taskId, runId: run.id, commit: run.resultCommit };
  });
  return {
    version: 1,
    taskRevision: task.revision ?? 1,
    contextRevision: project.contextRevision ?? 1,
    projectContext: project.context ?? '',
    taskSpec: taskInput.parse(task),
    dependencies,
    providerVersion:
      task.nodeId === 'local'
        ? (state.providers.find((p) => p.id === task.provider)?.version ?? null)
        : null,
    environment: {
      nodeId: task.nodeId,
      platform: task.nodeId === 'local' ? os.platform() : null,
      runtime: task.nodeId === 'local' ? process.version : null,
    },
  };
}

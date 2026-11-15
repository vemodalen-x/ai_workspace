# HTTP / WebSocket contract v0.1

Base: `http://127.0.0.1:4310/api`. UTF-8 JSON. Errors: `{ "error": "message" }`; 400 invalid schema, 401 missing API auth, 403 invalid Host/Origin, 404 unknown record, 409 invalid operation/state or execution preparation error. There is no shell-string API.

Bootstrap: `GET /bootstrap` returns `{token,version}`. The token is in-memory and rotates on backend restart. Every other API requires `Authorization: Bearer <token>`; browser WebSocket supplies protocols `workspace, auth.<token>` instead of putting credentials into a URL. Cross-site browser requests are rejected. Do not expose bootstrap through a public proxy.

| Method | Path                        | Input / result                                                                                                                          |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /snapshot                   | Projects, tasks, sessions, runs, workspaces, nodes, reservations, approvals, artifacts, latest events, provider status, current metrics |
| GET    | /events?after=0&limit=1000  | Ascending events with seq greater than cursor, max 2000 per page                                                                        |
| WS     | /events/ws?after=0          | Persisted replay followed by live normalized events. Reconnect with greatest processed seq; deduplicate by seq/id                       |
| POST   | /projects                   | `{name,repoPath,concurrency?}`; existing non-bare Git root with HEAD, returns Project                                                   |
| PATCH  | /projects/:id               | `{name?,concurrency?,archived?}`                                                                                                        |
| DELETE | /projects/:id               | Delete only empty metadata; never filesystem deletion                                                                                   |
| POST   | /projects/:id/tasks         | TaskInput below; returns Task                                                                                                           |
| PATCH  | /tasks/:id                  | Partial TaskInput; active task edits rejected; tree and DAG checked atomically before save                                              |
| DELETE | /tasks/:id                  | Rejects history, children and incoming dependency edges                                                                                 |
| POST   | /tasks/:id/runs             | `{requestKey,prompt?,sessionId?,model?,allowReal?,allowValidation?}`; returns queued Run                                                |
| POST   | /runs/:id/cancel            | `{mode:"paused" \| "cancelled"}`; cancel acknowledgement, outcome recorded asynchronously                                               |
| POST   | /runs/:id/reconcile         | `{confirmedStopped:true}`; orphaned only                                                                                                |
| GET    | /sessions/:id/diff          | `{diff}`; current local diff or retained remote/cleaned artifact                                                                        |
| POST   | /sessions/:id/merge-preview | Empty object; returns exact source/target SHA Approval; conflicts fail without editing target                                           |
| POST   | /approvals/:id              | `{approved:boolean}`; rechecks source, target, branch and cleanliness                                                                   |
| POST   | /sessions/:id/cleanup       | `{confirmed:true}`; refuses active, unknown, unmanaged or dirty workspace                                                               |
| POST   | /nodes                      | `{name,sshAlias,workerPath,cpu,ramMb}`; unverified SSH node                                                                             |
| POST   | /nodes/:id/probe            | Real local metrics or authenticated SSH worker probe                                                                                    |
| POST   | /providers/refresh          | CLI version/auth probes, no inference                                                                                                   |
| POST   | /scheduler/tick             | Trigger one scheduling pass; normal server ticks every 300ms                                                                            |

TaskInput:

```json
{
  "title": "Implement Backend API",
  "description": "Create endpoints and tests",
  "criteria": "Tests pass",
  "parentId": null,
  "dependencies": [],
  "provider": "codex",
  "nodeId": "local",
  "priority": 50,
  "allocation": { "cpu": 1, "ramMb": 512, "gpu": null, "vramMb": 0, "timeoutSec": 600 },
  "integration": false,
  "remoteRepoPath": "",
  "validationCommand": ["node", "--test"]
}
```

Launch requires `allowReal:true` for Codex/Claude and `allowValidation:true` for nonempty validation argv. These are per-launch acknowledgements; interactive native tool approvals are not implemented by these adapters. The transport does not claim to sandbox user-supplied validation commands.

Normalized event:

```json
{
  "seq": 42,
  "id": "uuid",
  "type": "MessageDelta",
  "runId": "uuid",
  "sessionId": "uuid",
  "projectId": "uuid",
  "createdAt": "2026-11-02T00:00:00.000Z",
  "data": { "text": "Working..." }
}
```

Provider events are translated into `SessionStarted`, `MessageDelta`, `ToolStarted`, `ToolCompleted`, `ApprovalRequested`, `FileChanged`, `UsageUpdated`, `SessionCompleted`, `SessionFailed`. Application events also include RunQueued/RunPaused/RunCancelled/RunOrphaned, MessageReceived, GitMerged, TaskChanged, ProjectChanged, NodeChanged, Log. A provider capability limitation is represented explicitly, never as a successful action.

Snapshot polling reconciles changes after reconnect; event sequence is global. Browser keeps latest 5000 replayed events in memory. Full history can be paged through `/events`. WebSocket slow consumers over 4 MiB buffered output are disconnected and must reconnect with cursor.

## v0.2 additions

- `GET /api/assistant`: authenticated, read-only attention queue and rolling seven-day Run counts. Same projection is returned as `snapshot.briefing`. No LLM invocation or execution side effects.
- `PATCH /api/projects/:id`: optional `context` string, maximum 12,000 characters. Existing authorization and serial mutation rules apply.
- Snapshot Runs may contain immutable `resultCommit`; context Artifacts contain the actual dispatched execution brief. Legacy records remain readable.

## v0.3 additions

Snapshot Runs include optional manifest; briefing items add `stale`. Existing task/project edits update revisions. Merge-preview and approve reject stale execution inputs with 409. Starting dependent tasks waits for current provenance. Continuing integration with changed dependency commits fails with a new-session explanation. New event: `RunStarting`. UI displays unknown for legacy manifests and requires the same real-provider/validation consent on rerun.

## v0.4 additions

- `GET /api/nodes/:id/telemetry?limit=120`: authenticated ascending receipt-time samples, limit 1–2160. Rows contain `nodeId`, `receivedAt`, `metrics`. PID arrays are live only. Unknown node: 404; invalid limit: 400.
- `GET /api/runs/:id/telemetry`: authenticated `{window: null | RunTelemetry}`. Only known execution windows are queried. Reports retained node sample count, first/last receipt, number of valid GPU utilization readings, their mean and observed memory/temperature maxima for the frozen GPU ID. No samples is distinct from zero usage.
- `POST /api/nodes/:id/probe`: joins an in-flight node check, or performs a read-only hardware probe. The new worker operation is `metrics`. Source time and trusted controller receipt time are distinct.
- Task input accepts optional `experiment: { group, dataset, datasetVersion, seed, parameters }`; `null` clears it. Parameters are bounded scalar values. A Run manifest freezes the specification and `environment.gpuId`.

## v0.5 additions

Approvals may be applying or superseded. POST /api/approvals/:id/reconcile checks a stored intent against the original target ref and returns the current approval. It requires normal local API authentication. GET /api/runs/:id/telemetry prefers telemetryAtFinish for completed experiment windows, with existing lookup behavior for historical records. Local experiment validation artifacts can include metrics and ignoredMetricLines. See [v0.5 semantics](quality-review-v05.md).

## Local command trials

Authenticated endpoints use the existing loopback API. A Trial is an immutable configuration. Each attempt owns its status, measurements, output and Git worktree.

| Method and path                    | Request or result                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/projects/:id/trials`    | Supply `title`, `argv`, `experiment` and `allocation` (the existing Task schemas). Saves configuration with the current committed HEAD.                                               |
| `POST /api/trials/:id/attempts`    | Send `{confirmed:true,requestKey:<UUID>}` after reviewing the command. Replaying the same key returns the original attempt. A new key starts a retry after the previous attempt ends. |
| `GET /api/snapshot`                | Includes `trials` and `attempts`. Logs and metric arrays are fetched on demand.                                                                                                       |
| `GET /api/attempts/:id/output`     | Returns `{log,logTruncated,metrics,ignored}`. Metrics use the existing stdout protocol. The most recent value for each (name, unit, step) wins.                                       |
| `POST /api/attempts/:id/cancel`    | Cancel queued or running work.                                                                                                                                                        |
| `POST /api/attempts/:id/reconcile` | `{confirmedStopped:true}` releases a quarantined reservation after operator inspection.                                                                                               |

Each command receives `WORKSPACE_TRIAL_ID`, `WORKSPACE_ATTEMPT_ID` and `WORKSPACE_EXPERIMENT` (JSON); training code applies its seed and parameters. GPU allocation sets `CUDA_VISIBLE_DEVICES` to the reserved device, or to an empty value for CPU. Commands run under the controller user's OS permissions. A clean worktree contains the files tracked at the frozen commit; prepare libraries in the local interpreter environment.

From v0.8.1, saving a trial creates a local Git ref at `refs/ai-workspace/trials/<trial-id>`. This keeps the input commit reachable through branch rewrites and garbage collection before the first attempt. Include these refs when backing up the source repository. Earlier trials still use the SHA recorded in SQLite and require that object to exist in Git.

Output retains the first 256 KiB of combined stdout/stderr and up to 5,000 distinct samples across 32 metric/unit series per attempt. Failed or cancelled attempts retain observed samples. A running attempt interrupted by a controller crash requires reconciliation. Worktrees and generated files stay on disk for inspection.

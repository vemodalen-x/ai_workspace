# Native session monitor

The monitor indexes local Codex and Claude Code transcripts read-only. Sessions on remote workers are not scanned. On Linux, Codex sessions are matched to the processes that hold their transcripts open. Claude Code does not keep its transcript open, and macOS/Windows have no `/proc`, so there liveness still comes from file writes and a session whose process exited mid-turn shows as stalled for up to 24 hours. Tool-approval waits are not distinguishable from waiting for input because neither CLI records them reliably. The monitor cannot send messages, resume or stop sessions, assign unassigned sessions to projects, or send notifications. Formats of other tools such as Cursor are not read. Details: [monitoring](monitoring.md).

# v0.8 command execution

Command trials run on the controller in a fresh Git worktree per attempt. CPU and memory reservations coordinate scheduling. OS-level sandboxing, distributed training and automatic cleanup of trial worktrees are outside this implementation. A user-supplied dataset version identifies the declared data; the training program is responsible for loading and verifying it. Cross-trial comparisons require a matching project, group, dataset, nonempty dataset version, metric and unit. Measurements from failed attempts remain available.

See [verification](verification.md) for current Windows and browser coverage.

# Historical v0.7 boundaries

The workflow refactor and independent Experiments page are delivered. App still coordinates project/session/configuration actions, and the backend Orchestrator remains a later decomposition target. Experiment is still captured task metadata; independent Trial entities, Command Runner and training metric time series are not implemented.

Filters and saved baselines are local to the current browser and origin. They are not synchronized between browsers. Experiment comparison still depends on completed, commit-matched validation reports. An unavailable saved baseline requires an explicit new selection. Session links show the conversation's latest execution rather than an immutable historical diff.

The latest Chromium attempt failed before page execution because process-singleton socket creation was denied. Shared-browser fallback could not reach the container dev server. Browser interaction and visual acceptance remain unverified. See verification.md for executed Node and production checks.

The original implementation limits below remain unless explicitly superseded in later release documentation.

# Known limitations — v0.1

This is Phase 1 plus selected Phase 2 components. Do not treat all features in the original product brief as complete.

## Implemented and exercised without paid inference

- Real SQLite state and event history, worktree creation, parallel Mock execution, structured event replay, cancellation/timeout, DAG/tree checks, reservation transactions, recovery quarantine.
- Integration workspace prepared from dependency snapshot commits; actual configured validation argv executes with exit-code handling.
- Read-only diff, merge-tree conflict detection, exact-SHA approval, guarded fast-forward integration, conservative cleanup.
- Real worker process protocol, filesystem work, completed Run ID replay, claim/session locks, path containment.
- Native CLI version/auth probes; Claude structured protocol contract tests and Codex SDK type integration.

## Not verified in this execution environment

- No real Codex/Claude inference was launched. Subscription entitlements, end-to-end provider tool execution and paid smoke tests remain opt-in.
- Cloud-browser policy blocked the local preview during UI QA. Playwright tests are delivered but **were not run** here. Layout and interaction quality require browser acceptance on the user's computer or CI.
- No remote machine, SSH key/host, Windows machine or NVIDIA GPU was provided. No claim of remote/Windows/GPU hardware acceptance is made.
- GitHub CI configuration is provided; remote CI was not triggered or observed.

## Product and operational gaps

- One Git repo per project; no multi-repository atomic integration.
- A Task can have multiple historical Sessions, but only one active Run per Task. Other tasks execute in parallel.
- No automatic retry policy, generalized conditions, cron triggers, long-running daemon worker or distributed lease consensus. Explicit retries create new Run IDs.
- CPU/RAM/VRAM are soft reservations; no cgroups, containers, process Job Objects, token/cost enforcement or GPU process attribution. `CUDA_VISIBLE_DEVICES` is not security isolation.
- Node/GPU history survives restart within the bounded v0.4 retention window. PID lists are live only. Codex SDK does not expose the child PID through this adapter; its per-process metric display is unavailable.
- Native provider interactive tool approvals / mid-turn steering are not implemented. Claude uses a restricted tool list; explicit validation argv runs separately. Permissions cannot be approved from the UI mid-tool-call.
- Codex SDK cancellation has no exposed child PID in this adapter; interrupted Codex runs are conservatively quarantined as orphaned until the operator verifies the child processes stopped.
- Resume is conversation continuation, not resuming a frozen OS process. It depends on Provider-native session history remaining available.
- Remote diffs can be inspected; remote commit transfer, merge UI and cleanup UI are not implemented. Remote failure outcome is conservatively quarantined.
- Git and SQLite changes are not one atomic transaction. Git snapshot or merge may complete immediately before a crash prevents recording the result. Inspect commit SHAs during reconciliation; never blindly rerun.
- SQLite JSON payload storage has application-level relationships, no full normalized FK schema or forward migration framework yet. Event/snapshot queries are suitable for a personal workspace, not unbounded multi-tenant workloads.
- Current UI includes create/edit/duplicate/reparent, launches, interruption, diffs and approvals, but project rename/concurrency changes and empty-project deletion are API-only. Tree collapse, advanced graph editing, richer task state aggregation, full-history pagination UI and more keyboard navigation remain follow-up work.
- Provider stdout is treated as trusted local program output for rendering as escaped text. Common credentials are redacted, but perfect arbitrary-secret filtering is not possible. Do not share database/log files blindly.
- The app protects API access from common browser-origin attacks; a compromised local account/process can access the service and state. It is not an adversarial multi-user security boundary.
- Externally concurrent Git mutations are outside the application's lock. Avoid modifying the target repo during final approval. Stale expected SHAs and dirty status are rejected when detected.
- Graph and terminal JavaScript load on demand in v0.5. Full snapshot payloads still grow with project history.

## Next release gates

1. Run Playwright and visual QA at desktop/mobile widths; native Windows process-tree and Git path tests.
2. Run explicitly authorized Codex/Claude smoke tests against installed versions.
3. Test a real SSH host: stop worker, drop network, reconnect, reconcile, compare returned commit/diff.
4. Add cgroup/container capability enforcement and verified process-group lifecycle before promising hard resource limits.
5. Add durable remote event replay / lease fencing, remote commit import, interactive approvals and richer project controls.

## v0.2 assistant limits

The assistant uses rules, not an LLM planner. No due dates, reminders, snooze, external inbox/calendar, automatic prioritization learning, or measured productivity uplift. Seven-day counts are Runs, not delivered tasks. Legacy Runs without resultCommit and commits integrated through other sessions are not inferred as merged. Context is character-bounded, may include explicit truncation, and is sent to the selected Provider. It is user-maintained and must not contain credentials. Agent semantic summaries, dependency-version invalidation and aggregate-project verified completion remain future work.

## v0.3 remaining boundaries

Task edits conservatively invalidate evidence even for priority-only changes. Unknown legacy dependencies require rerun before downstream scheduling. Validation in a clean worktree does not inherit node_modules or other untracked assets; configure environment preparation explicitly. Dirty validation directories are retained at the path in command-validation.json, without dedicated cleanup UI. Git/DB merge crash reconciliation, complete service/frontend modularization, durable remote transport and event relay remain pending. See reliability-v03.md.

## v0.4 GPU and experiment scope

Fleet monitoring and bounded **node telemetry history** are implemented. Physical NVIDIA GPU observation is distinct from per-process SM attribution, multi-GPU reservations, distributed training control or experiment-quality metrics; those are not implemented. GPU hardware/real remote-host acceptance is operator-run using [check:fleet](experiment-fleet.md). The polling cap and retention bound are intended for personal fleets.

## v0.5 scope

The recorded merge intent now supports target-ref reconciliation across Git and database writes. Manual server-lock recovery, external history rewrites and lost remote execution remain operator concerns. Experiment metrics come from approved local validation commands. Real GPU, remote, Windows and browser acceptance remain pending. See [quality review](quality-review-v05.md).

# Implementation plan

## Phase 0 — discovery

- Empty working directory; no existing source to modify.
- Node 24.22.1, npm 11.9.0, Git 2.51.1 available.
- Codex/Claude executables absent initially. Check installed SDK types and CLI help after dependency installation. Never execute a paid inference during automatic checks.
- GitHub connector checked; no matching repository under the connected owner. Deliver a new Git checkout and portable source archive; do not write an unrelated repository.

## Phase 1 — runnable vertical slice

1. Shared schemas and SQLite entities, migrations, persistent events.
2. Safe worktree manager, DAG validation, transactional queue/resource reservation.
3. Mock execution plus Codex SDK and Claude JSONL adapters with explicit capability flags.
4. Project/task/session/run APIs, event replay, cancellation, timeout, conservative crash recovery.
5. Dark developer control center: task tree/graph, console, diff, inspector, metrics, activity and approvals.
6. Deterministic tests with actual temporary Git repositories and SQLite files; opt-in provider tests.

## Phase 2 — bounded additions in first version

SSH worker transport and setup docs, real remote command execution contract, offline quarantine, local merge preview/approval, dependencies and explicit integration worktrees. Test transport failures without claiming live remote verification.

## Phase 3 — follow-up

Native Windows validation, cgroups/job-object enforcement, durable worker leases and reconnect, remote patch import/integration, provider interactive approvals, token/cost budget enforcement, multi-repository atomic integration, project budget editing, richer keyboard workflows, automatic bounded retry policy and persistent metric history.

## Acceptance contract

Mock A/B run concurrently in distinct worktrees; C depends on both, becomes schedulable only after successful execution, and receives an explicit integration workspace containing their committed outputs. Validation result remains distinct from integration approval. Refresh preserves all events. Conflicts stop integration preparation. Real providers require installation/authentication and explicit user launch; remote live tests require a supplied host.

## Delivered increment v0.2

Focus inbox, inert capture, explicit project context, dispatch-time execution briefs, per-run result commit provenance, and seven-day review. Next: dependency-version freshness, structured handoff, global work-in-progress limits, and real host/browser acceptance. See [productivity-upgrade.md](productivity-upgrade.md).

## Delivered v0.3 increment

Run manifests, transitive evidence freshness and stale merge guards; immutable dependency commits; separate candidate verification; core state/event transaction boundaries and lifecycle guards; evidence/context/manifest/verification modules; UI stale reasons and new-session rerun entry. Remaining architecture-review phases are tracked in reliability-v03.md.

## v0.4 delivered slice

Comparable experiment inputs, single-GPU UUID binding, multi-host/physical-GPU sampling, bounded telemetry history, node and Run-window projections, and a read-only fleet acceptance command. Next gates: live Windows/Linux NVIDIA and SSH validation, application-reported step/quality metrics, then all-or-nothing multi-device scheduling and DDP lifecycle. Do not infer training performance from fleet activity alone.

## v0.7 delivered refactoring increment

Independent Experiments navigation, extracted shell/tree/presentation components, URL-backed location restoration and stable comparison baselines. No change to backend execution semantics. Follow with Command Runner and immutable Trials, then durable Worker reconciliation and multi-device scheduling. See refactoring-v07.md.

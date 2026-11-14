# AI Agent Workspace — architecture

Version 0.1, 2026-11-02. Local-first, single-owner control plane; Node 24+, Windows/Linux. No cloud service is required.

## Boundaries

React UI → same-origin Fastify HTTP/WebSocket → application services → SQLite WAL / Git / adapter / execution transport. UI never launches commands or receives credentials. The server binds 127.0.0.1. A per-boot bearer token and Origin/Host checks protect command APIs against cross-site requests. Bootstrap is same-origin only. This is a trusted local-user application, not a multi-tenant sandbox.

Task is intended work; Session is a conversation plus owned worktree; Run is one attempt/turn. Task parentage is an organizational tree, dependencies a separately validated DAG. Completion is agent execution completion, never an implicit claim that code is integrated or tests passed.

Each write session gets a unique branch and worktree at a recorded base commit. Only one active run per session and task. Resource reservations and active-run uniqueness are database constraints, checked inside BEGIN IMMEDIATE transactions. Sessions can be resumed with subsequent runs. Explicit run idempotency keys prevent duplicate launches. Global event sequence numbers support cursor replay and client deduplication.

SQLite node:sqlite is used directly behind a repository boundary, avoiding native addon installation and unnecessary ORM complexity in this first slice. Schema is versioned; a future PostgreSQL/Drizzle implementation must retain transaction semantics. Filesystem/Git and SQLite are not a distributed transaction: pending state is persisted first; failures remain visible and worktree cleanup is conservative.

## Providers

Codex: official @openai/codex-sdk, startThread/resumeThread/runStreamed, AbortSignal, workspace-write sandbox, never auto-approve escalation. App Server is a future adapter for interactive permission callbacks; SDK does not offer identical capabilities.

Claude Code: official unmodified CLI, -p --output-format stream-json --verbose --include-partial-messages, --resume. Tool allowlist permits file reading/editing; shell execution is not broadly auto-approved. Native Claude authentication remains native. The SDK is evaluated but not selected for the initial subscription-oriented CLI workflow. No tokens are extracted, transferred, or converted into API keys. Headless permission denials are reported, not silently approved.

Mock: explicit test provider; writes real fixture files in worktrees, streams deterministic events, supports failure/delay fixtures. Its usage is unavailable, not invented. No mock is disguised as Codex/Claude.

## Remote execution

SSH invokes an installed Node worker using a fixed entry path, BatchMode, strict host-key verification, and a user-configured SSH alias. Requests/events use bounded JSONL on stdin/stdout. The worker owns its isolated worktree, emits metrics and diff, and cancels on input EOF. This is an attached execution transport, not a durable distributed queue. A disconnect leaves execution outcome uncertain, quarantines capacity, and requires explicit reconciliation; it must not auto-retry. Remote repository paths are explicit and base commit equality is checked. Local Git integration of remote changes is deferred in this slice; the diff is retained for review.

## Recovery and budgets

On graceful shutdown, abort active runs and await settlement. On unclean restart, mark active runs interrupted/unknown, quarantine their reservations and sessions, and require operator reconciliation before retry/cleanup. Never kill a possibly reused PID. Queued work is recoverable. No exactly-once guarantee is claimed across crashes and external tools.

CPU/RAM/GPU allocations are soft scheduling budgets, separate from sampled usage. NVIDIA metrics are real nvidia-smi readings; unavailable metrics are null. Wall-clock timeout is enforced by cancellation. OS CPU/RAM limits, per-process GPU attribution, and token/cost enforcement are not claimed in v0.1. Linux cgroups/container support is a later transport capability.

## Git safety

Diff is read-only. Snapshot commits only app-owned worktrees. Merge preview uses merge-tree; approval is bound to exact source and target commits. Final merge checks clean target, branch and both SHAs again, and uses fast-forward to the reviewed merge commit. No reset --hard, clean -fd, force branch deletion, or user-repository deletion. External Git writers remain outside the application's lock; Git ref locking and expected HEAD checks fail closed when detected.

## Official references checked

- https://developers.openai.com/codex/sdk
- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/legal-and-compliance

Installed dependency/CLI checks and verification results are recorded in verification.md. Account entitlements and billing are provider-owned; versions and capabilities are probed without inference calls.

## v0.2 attention and context layer

`packages/shared/assistant.ts` contains pure, deterministic briefing/evidence functions; `apps/web/src/Focus.tsx` provides capture, context editing, and attention actions. Orchestrator builds the context artifact at dispatch after dependencies complete. This layer does not authorize execution or merge. See [productivity-upgrade.md](productivity-upgrade.md) for design decisions and evidence boundaries.

## v0.3 reliability boundaries

Evidence and context are separate pure modules. Manifest capture, lifecycle transitions, and candidate verification have dedicated orchestration modules. Core state/events share a transaction and subscribers see committed data only. See [reliability-v03.md](reliability-v03.md). Git merge/DB reconciliation and complete Orchestrator decomposition remain pending.

## v0.4 observability boundary

NVIDIA collector → validated Metrics → controller receipt timestamp → latest RAM snapshot + bounded SQLite telemetry. NodeMonitor owns probe concurrency, deadlines, single-flight and backoff. The Run scheduler consumes fresh capacity and stores resolved GPU identity in the manifest. Fleet/history and Run-window views read projections; they never infer training metrics or ownership from shared-device activity. See [experiment-fleet.md](experiment-fleet.md).

## v0.7 frontend workflow boundaries

AppShell, Sidebar, TaskTree and reusable UI primitives are separate from App's application actions. ExperimentsPage and Compute have independent lazy entries. Hash routes own navigation state; browser-local preferences own filters and per-group/per-metric baseline references. The comparison window does not decide the baseline. See [refactoring-v07.md](refactoring-v07.md) for compatibility, browser persistence and intentionally deferred execution-domain changes.

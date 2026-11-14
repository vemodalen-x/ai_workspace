# v0.7 — Workflow navigation and experiment review

2026-11-12. This is the first bounded increment of the product/architecture refactor. Execution, Git approval, resource reservation and SQLite semantics remain unchanged. No database migration is needed.

## Delivered boundaries

- `main.tsx` only mounts providers and App.
- `AppShell` owns header, sidebar composition, task inspector sizing and footer. `Sidebar` owns primary navigation and project shortcuts.
- `TaskTree` renders hierarchy and emits select, move, launch and menu intents. App performs authenticated mutations; tree parentage still does not define execution dependencies.
- `UiPrimitives` owns the existing modal, field, empty, meter and timeline presentations.
- `ExperimentsPage` is lazy loaded independently from `Compute`. Compute only displays nodes, GPU capacity and telemetry.
- `navigation.ts` is a pure, bounded URL codec. `useWorkspaceRoute` synchronizes hash URLs, browser history and last location. Changing task/session/project context is an atomic navigation intent.
- `preferences.ts` owns best-effort local preferences. Unavailable storage leaves the in-memory UI functional. Comparison preferences use explicit shape validation.
- `comparison-selection.ts` owns the bounded display window independently of baseline selection.

App still coordinates business workflows and contains the project, session, inspector and configuration views. Orchestrator decomposition, independent Trial entities and Command Runner are subsequent increments, not delivered features.

## User workflows

Primary navigation puts Focus, Projects, Experiments and Compute first. Overview, All sessions and Activity remain available. The task inspector is displayed on Project and Session pages only. Narrow navigation buttons have accessible names and titles. A keyboard skip link targets the workspace.

Locations use `#/experiments`, `#/compute`, and task/session query parameters. Project, task, session, tab, tree/graph mode and search survive refresh. Back/forward restores previous locations. Search edits replace the current history entry. No prompts, commands or authentication tokens are encoded in URLs. Experiment project/group filters, metric/baseline selections, node filters, GPU ordering and Focus filters are browser-local preferences; they are not encoded in a shareable experiment URL or synchronized between browsers.

Experiments shows recorded groups and execution counts, a project filter, group selector, comparisons and expandable Run evidence. Workspace search matches groups using project/group name, task title and dataset metadata. The Create experiment task action uses the selected active project when filtered, otherwise the current active project. Its form enables experiment tracking, names the project, and creates only a draft. After save the Project task view is opened. A project must be imported first if none is available.

`Open session` deliberately opens the associated conversation and its latest execution, not an immutable historical diff. The ledger keeps the captured inputs and individual Run ID visible.

## Stable comparison decisions

Comparison preferences are scoped by `(projectId, experiment group)` and store a separate baseline Run ID per `(metric name, unit)`. On first viewing a metric the oldest available reading in that group is selected and saved. A user can select another baseline. The baseline remains available as history grows, even outside the latest 20 displayed Runs. The comparison then shows up to 21 rows: the latest 20 plus the baseline.

A missing saved baseline or missing baseline reading is reported explicitly. No deltas are computed until the user chooses an available baseline. Unit, dataset/version, experiment and step compatibility checks are unchanged. Failed runs remain visible but still have no commit-matched validation metric under the existing evidence protocol.

This release does not implement experimental metric time series, independent training execution, multi-seed statistics, durable SSH leases, multi-GPU allocation or hard GPU isolation.

## Verification and next increment

See verification.md for executed checks and browser environment blockers. Browser tests include deep-link refresh/back navigation, saved compute filtering, pinned baseline persistence/history growth, missing baseline handling and a 390px viewport. A passing Node test is not a substitute for those browser checks.

Next: isolate Run application use cases, introduce an explicit execution specification and Command Runner, then add immutable Trial records and metric series. Each increment must preserve current worktree, evidence and approval invariants.

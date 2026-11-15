# v0.8 verification, 2026-11-14

Windows with Node 24.19 and Git for Windows passed TypeScript, ESLint, 61 core tests and the web, server and worker production builds. The trial tests use real subprocesses, SQLite and Git worktrees. They cover the frozen commit, fresh retries, failed output, idempotency, competing project slots, cancellation and restart reconciliation.

All nine Playwright scenarios passed using installed Chrome. The command-trial flow creates a draft, confirms the executable and commit, runs twice, compares step readings, refreshes and checks horizontal layout at 390px. Other scenarios cover Agent merge approval, navigation and baseline persistence. Paid provider inference, physical GPU execution and remote SSH training are outside this run.

# Verification record — v0.7, 2026-11-12

This increment changes frontend workflow boundaries, navigation and comparison persistence. Backend execution semantics are unchanged. No real paid inference was launched.

- `npm run check`: PASS — TypeScript, ESLint, **58 core tests (0 failed, 0 skipped)** and Web/server/worker production build. Three new tests cover route round-trips and invalid input, pinned baselines outside the display window, and malformed preference data.
- `npm run test:production`: PASS — one compiled-server startup, authenticated API/static Web and shutdown test.
- `npm run format:check` and `git diff --check`: PASS.
- `npm run preview:visual`: PASS — standalone embedded-JS/CSS sample-data preview built and server-rendered. Upstream lucide `use client` bundle warnings remain visible and do not prevent this client-only build.
- First-load Web entry is 328.02 kB minified / 99.85 kB gzip. Experiment and Compute pages load separately. This is a bundle measurement, not a measured interaction latency improvement.
- `PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e`: attempted. All 8 scenarios were blocked before page execution by Chromium's process-singleton socket failing with `Operation not permitted`. **No browser scenarios passed.** Chromium is installed in this environment, unlike the earlier v0.6 record.
- Shared-browser fallback to the isolated dev service returned `ERR_CONNECTION_REFUSED`; no browser layout, click, back/forward or narrow-viewport acceptance is claimed.
- `npm run test:e2e -- --list`: 8 scenarios found in 2 files. The new fixture-based comparison test checks saved baseline/metric across refresh, history growth beyond 20, and explicit selection when the baseline disappears. The deep-link and 390px layout cases still require execution in a working browser environment.
- No live Windows, SSH host, NVIDIA GPU or remote CI acceptance in this increment. Existing hardware limitations remain.

For an installed system Chromium, the test config supports `PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/chromium`. Otherwise install Playwright Chromium normally. The browser executable override does not alter application security settings.

Prior records below describe their own versions and environments.

# Verification update — 2026-11-07, v0.6.0

Implemented the fleet and experiment visualization changes first, then ran verification.

- TypeScript, lint, formatting, 55 core tests, production builds and one compiled-server startup/API/static Web/shutdown test passed on Linux. The three new tests exercise real component SSR and the shared capacity/comparison calculations using isolated fixtures.
- GPU reservation calculations are shared between admission and display. Regression coverage includes node-scoped UUID/index budgets, quarantined allocations, withheld offline headroom, ranked cards, signed metric changes, mismatched units/projects/steps/datasets, and chart gaps and single samples.
- Built the offline design review from the actual UI components. Checked the generated HTML for embedded assets and the sample-data label, and syntax-checked its inline JavaScript. No preview data enters the production workspace.
- Five Playwright tests discovered. The newly added interaction test was attempted and could not start Chromium. The official installer received an invalid ZIP. Zero browser scenarios passed in this environment. Desktop/mobile pixels, keyboard focus transitions and actual browser clicks remain unverified. No real SSH/GPU or paid-agent workload was run.

# Verification update — 2026-11-07, v0.5.0

- Linux, Node 24.22.1. TypeScript, ESLint, 52 core tests and production build passed. One separate production startup/API/static web/shutdown test passed. Total 53 executed passing tests.
- Baseline checkout 1f99dbb built with the same dependencies. Initial minified JavaScript 852.20 kB → 343.30 kB, gzip 243.75 kB → 103.98 kB. Graph and terminal chunks load on demand. This measures entry payload size, not page-load latency.
- Chromium acceptance attempted. The executable was absent and the official Playwright installer received an invalid ZIP. Four browser tests discovered, zero browser scenarios completed. Windows, authenticated real providers, real GPU and remote SSH hardware acceptance remain outstanding.
- Seven new tests passed. See [quality review and reproduction](quality-review-v05.md). No paid inference ran.

# Verification update — 2026-11-06, v0.4.0

- Linux, Node 24.22.1. Type checking, ESLint, production Web/API/Worker builds, Prettier and Git whitespace checks pass. No new dependency was required.
- 45 core tests passed, zero skipped; compiled server startup/API/static Web/shutdown passed separately. Total: 46 executed automated tests.
- Ten new tests cover multi-GPU parsing with partial values, UUID/index admission, freshness and retention/restart, bounded concurrent polling and backoff, API auth/isolation, experiment provenance, standalone Worker metrics, Run-window aggregation, validation subprocess CUDA visibility, and server-rendered fleet presentation. Synthetic GPU data is confined to tests. The SSR check is not a browser interaction test.
- `npm run check:fleet` ran the local collector: 9 logical CPU cores, about 10 GiB RAM, GPU unavailable. SSH transport to a real remote host, NVIDIA hardware, MIG, Windows, paid Agent inference and model training were not exercised. Operator acceptance: `npm run check:fleet -- fleet.local.json`.
- Four Playwright scenarios listed; not executed in a browser. Production bundle retains the existing nonfatal size warning.
- During verification, tests caught quoted GPU names containing commas and real first-sample missing network rates; both were fixed and rerun.

# Verification update — 2026-11-04, v0.3.0

- `npm run check`: PASS — strict TypeScript, lint, **35 core tests, 0 failed, 0 skipped**, production Web/server/worker build.
- `npm run test:production`: PASS — 1 actual compiled-server startup/API/static Web/shutdown test. **36 executed tests total**.
- `npm run format:check`, `git diff --check`: PASS.
- Nine new tests in provenance.test.ts exercise transaction rollback and subscriber ordering, injected event insert failure, immutable dependency commits, transitive stale evidence and merge rejection, version/prompt provenance, isolated candidate verification and source mutation rejection, cleanup and state-machine guards.
- No paid Agent workload, Windows host, real SSH/GPU or browser acceptance was executed. Existing Playwright scenarios remain supplied; previous browser preview restriction was not bypassed.
- Web bundle: 841.15 kB minified / 240.48 kB gzip; nonfatal bundle-size warning remains.
- Dependency versions unchanged. Root package and lockfile version are 0.3.0; clean npm installation was not repeated.

GitHub publishing is tracked separately from local validation. At packaging time the connector had no repository-creation action and the GitHub webpage required sign-in. No remote CI success is claimed in this record.

# Verification update — 2026-11-03, v0.2.0

- `npm run check`: PASS — typecheck, ESLint, **26 core tests (0 failed, 0 skipped)**, Vite and Node builds.
- `npm run test:production`: PASS — 1 compiled-server startup/API/Web/shutdown test. **27 executed automated tests total**.
- `npm run format:check` and `git diff --check`: PASS.
- `npm run test:e2e -- --list`: 3 Playwright scenarios discovered, including capture → clarify → context persistence without execution. Browser execution remains unverified under the previously observed URL policy restriction; no workaround attempted.
- No paid inference, live SSH/GPU, Windows host or remote CI execution in this increment.
- No new dependencies; package/lock root version updated together. Clean dependency installation was verified for v0.1 below, not repeated for v0.2.
- Web bundle: 839.32 kB minified / 239.92 kB gzip; size warning remains visible.
- GitHub `vemodalen-x/ai-agent-workspace` lookup still returns 404; no remote push claimed.

Six new automated cases cover inert capture and independent parent/dependency semantics; exact run-to-commit approval evidence across continuation; missing/malformed evidence and review window; persisted dispatch briefs with dependency results and prior failure; orphan/provider/offline triage; and authenticated API/context bounds. Existing 20 cases were rerun, including actual Git and Worker operations.

The following is the preserved v0.1 verification record, not a claim that its optional checks were repeated in v0.2.

# Verification record — 2026-11-02

Environment: Linux; Node.js 24.22.1; npm 11.9.0; Git 2.51.1. No paid Agent inference was executed.

## Executed checks

| Check                        | Actual result                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                     | PASS — clean lockfile installation, 301 packages                                                                                |
| `npm run typecheck`          | PASS — strict TypeScript, frontend/backend/worker/tests                                                                         |
| `npm run lint`               | PASS — ESLint                                                                                                                   |
| `npm test`                   | PASS — 20 tests, 0 failures, 0 skipped                                                                                          |
| `npm run build`              | PASS — Vite Web bundle + Node server/worker ESM bundles                                                                         |
| `npm run format:check`       | PASS — Prettier                                                                                                                 |
| `npm run test:production`    | PASS — 1 compiled-server smoke test: actual startup, static Web 200, authenticated snapshot 200, graceful exit and lock release |
| `npm run test:providers`     | 2 explicitly skipped — Codex and Claude require opt-in to consume quota                                                         |
| `npm run test:e2e -- --list` | 2 Playwright tests discovered and parsed; **not executed in a browser**                                                         |

The production smoke initially caught tsup removing the `node:` prefix from `node:sqlite`. `tsup.config.ts` now sets `removeNodeProtocol: false`. The compiled server was rebuilt and the startup/shutdown check passed. Compiling alone was not considered sufficient verification.

The Web bundle has a non-fatal size warning (~832 kB minified, ~238 kB gzip). Code splitting is deferred; no build warning was hidden by increasing a threshold.

## Automated cases exercised

1. Claude structured flags, resume and event translation.
2. Claude permission denial and missing result fail closed.
3. HTTP authorization, Host/Origin checks, invalid input, paged event replay.
4. WebSocket event delivery after a saved cursor.
5. Known environment credential patterns and Bearer redaction.
6. DAG cycles/missing nodes, independent parent tree, path containment.
7. Real A/B parallel worktrees, C dependency integration, JSON validation, exact-SHA merge approval, SQLite history after reopen.
8. Duplicate Run request and duplicate event suppression; multiple turns in one Session.
9. Agent failure releases capacity, blocks dependents, explicit retry unblocks.
10. Cancel, interrupt and timeout have distinct outcomes.
11. Transactional CPU/RAM reservation prevents overbooking; GPU unavailable and offline nodes rejected.
12. Scheduler holds resource-starved and offline SSH work without launching.
13. Unclean restart quarantines unknown runs; operator reconciliation is required.
14. Worktree cleanup refuses dirty state and retains branch/user repository.
15. Merge conflict and stale approval do not mutate target HEAD.
16. Tree/edge cycles and active-task mutations are rejected.
17. Codex SDK interruption with unknown child PID conservatively quarantines allocation (injected deterministic adapter; no Codex inference).
18. Separate Worker process executes real worktree writes and replays a completed Run ID without re-executing.
19. Worker rejects out-of-root repository; JSONL runner rejects malformed protocol output.
20. Explicit validation argv executes actual Node commands; nonzero exit code fails Run and releases capacity.

The additional production smoke brings the successfully executed automated checks to **21 tests total** (20 core + 1 production). This is not 21 browser tests.

## Provider discovery

- Official Codex SDK and bundled CLI: 0.166.0. Installed TypeScript definitions for startThread/resumeThread/runStreamed/AbortSignal were read. CLI `--version`, `exec --help`, and `login status` were run without inference. Native login was present in this environment, but no workload was launched.
- Official Claude Code: 2.1.316. CLI `--version`, `--help`, and `auth status` were checked. Native executable layout (`bin/claude.exe`, ELF on Linux) was verified. Authentication reported not logged in.
- Provider status in the user's installation is re-probed; these environment observations are not hard-coded into the UI.

## Unverified acceptance gates

- Browser UI: the managed preview daemon started, but the cloud browser's URL/security policy rejected further access to the local preview. No alternate browser/control route was used to bypass that rejection. The Playwright suite is delivered for local/CI execution; visual and interaction acceptance remain pending.
- Windows: compatible paths/process code and CI matrix are supplied, but no Windows host was available.
- SSH: worker protocol was tested in local subprocesses; no live SSH host/authentication/network partition was tested.
- NVIDIA GPU: no GPU was available to verify hardware telemetry.
- Real agents: no paid smoke test; no full Codex + Claude A/B acceptance run.
- GitHub: read-only account/repository discovery completed; no matching `ai-agent-workspace` repository was found under the connected owner. No remote repository was created/pushed, and no remote CI result is claimed.

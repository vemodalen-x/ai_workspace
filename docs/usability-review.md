# Workspace usability review — 2026-11-19

Scope: project folder loading, native history navigation, shared dialogs, Chinese/English UI. Reviewed from cc6ee7b in a clean checkout; existing changes in the original workspace were preserved.

## Findings and changes

- **P2 — misleading accessibility semantics:** history declared `tree` / `treeitem` without the required tree keyboard model or expanded states. Replaced it with nested lists and disclosure buttons with `aria-expanded`, `aria-controls`, native Enter/Space activation and visible focus. This is a disclosure list, not an ARIA tree widget.
- **P2 — unnamed dialogs:** the heading was not connected to the dialog's accessible name. All shared dialogs now use a unique heading ID with `aria-labelledby`.
- **Usability — excessive history detail:** all branches opened by default. Sessions now start collapsed, with expand/collapse-all controls. Polling retains manual choices. Search trims incidental whitespace, reveals matching branches and offers a clear action which restores the prior expansion state. Search does not translate or rewrite source records.
- **Usability — folder discovery:** added filtering within the returned folder listing, empty-match feedback, a loading label and explicit explanation that folders belong to the Workspace server machine. The existing 300-folder limit and direct-path escape remain visible.

Project switching already keys history components by project ID; no cross-project selection defect was confirmed. No change to registration, removal, provider history matching, task execution or remote-node configuration.

## Public guidance consulted

- [W3C APG: Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/): explicit expanded state and Enter/Space activation.
- [W3C APG: Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): tree semantics imply a complete keyboard interaction model; a nested disclosure list fits this read-only UI better.
- [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): defer secondary detail while keeping it readily accessible.

These pages were retrieved successfully during the review. This is an incremental usability improvement, not a complete accessibility audit or a user study.

## Verification

Run `npm run check`, `npm run test:production`, and `npm run test:e2e`. History browser cases require isolated `CODEX_HOME` and `CLAUDE_CONFIG_DIR` plus `WORKSPACE_HISTORY_TREE_E2E=1` and `WORKSPACE_EXTERNAL_SESSION_E2E=1`. Use `PLAYWRIGHT_EXECUTABLE_PATH` when relying on a system Chromium installation.

Added browser coverage for keyboard expansion, poll/refresh state retention, whitespace-normalized search, no-results recovery, both languages and 390px layout; extended folder tests to check the accessible dialog name and filtering. Existing real JSONL fixtures continue to check both providers, incremental history, source navigation and read-only behavior.

Not covered locally: Safari/Firefox, screen-reader sessions, real paid provider execution, remote Mac behavior, OS reboot/recovery. No claim that this review validates those flows.

# Decision Journal: Issue #97 — Correct policy-package status

**Issue**: #97 | **Branch**: `codex/issue-97-policy-status-docs` | **Started**: 2026-08-16

---

## Context

Flow implements strict local and exact installed policy packages. The README and detailed Gate 6
roadmap section report that status. Other public summaries still group policy packages with planned
UI packages. The documents therefore give contradictory product-status information.

## Scope

This issue makes public status and limitation statements consistent. It does not change production
source, package schemas, discovery, selection, snapshots, commands, dependencies, or runtime
behavior. A documentation regression test binds the corrected status.

Policy engines, external decision points, dynamic policy download, and UI contribution packages
remain separate future work. Their status does not contradict the implemented inert narrowing
package contract.

## Verification map

| Criterion | Evidence | Expected result |
| --- | --- | --- |
| Roadmap consistency | Search all public documentation for policy-package status statements | Every general status statement marks inert policy packages implemented |
| Remaining-work accuracy | Review each future-policy statement in context | Only genuinely unimplemented policy capabilities remain future work |
| Product stability | Inspect the branch change classification | No production source, schema, dependency, example, or command file changes |
| Prose and formatting | Run documentation, formatting, and diff checks | All selected checks pass |

## Implementation evidence

The initial focused regression failed against the merged roadmap summary. It detected that the
remaining-targets sentence still listed policy packages. After the public status correction, the
same test passed.

| Evidence | Command | Result |
| --- | --- | --- |
| Focused RED and GREEN | `npx vitest run test/scaffold/community-files.test.ts -t "reports implemented policy packages separately from planned UI packages"` | Failed before the correction and passed after it |
| Complete public-contract scaffold | `npx vitest run test/scaffold/community-files.test.ts` | 28 tests passed |
| Type checking | `npm run typecheck` | Passed |
| Lint | `npm run lint` | Passed with one inherited informational finding |
| Prose | `npm run docs:ste` | Clean |
| Formatting | `npm run format:check` | Passed |
| Diff integrity | `git diff --check` | Passed |
| Semantic stale-status search | Search current README and documentation for combined deferred policy and UI status | No current public match |

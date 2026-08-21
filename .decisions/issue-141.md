# Decision journal: Issue #141 — Make immutable preview publication compatible with GitHub Actions authority

**Issue:** #141 | **Branch:** `codex/issue-141-preview-publication-authority` | **Started:** 2026-08-21

## Context

Preview run 32445206680 passed preparation, both supported host verifiers, and attestation. The
protected publication job then failed before mutation. GitHub returned HTTP 403 when its
short-lived token tried to read the repository administration endpoint for immutable releases. No
release or tag was created.

## Decision

Keep release immutability as an operator-verified prerequisite of the protected environment. The
required reviewer must query the administration endpoint with a repository-owner session before
approval. Remove the impossible workflow-token query. Do not add a long-lived administration token
or bypass the environment gate.

## Failure modes

- If the setting query fails or doesn't return `true`, the reviewer doesn't approve publication.
- If either host or attestation fails, GitHub doesn't offer the publication environment for review.
- If a release or tag already exists, the publication job fails before draft creation.
- If publication settlement is uncertain, the operator inspects the release and tag before retry.

## Acceptance verification map

| Criterion | Evidence command | Expected result |
| --- | --- | --- |
| The workflow uses no unavailable administration query. | `npx vitest run test/scaffold/preview-release-workflow.test.ts` | Publication keeps the protected environment and contains no immutable-releases API call. |
| The reviewer has a fail-closed procedure. | `npm run docs:style && npm run docs:links && npm run docs:ste` | The runbook gives the exact owner query and stop conditions. |
| Publication retains its remaining gates. | The public `Preview release` workflow | Both hosts and attestation pass before approval, and the unused identity check precedes mutation. |

## Evidence

- `npx vitest run test/scaffold/preview-release-workflow.test.ts test/scaffold/community-files.test.ts test/integration/package/documentation-structure.test.ts test/scaffold/package.test.ts`: 42 tests passed across 4 files.
- `npm run docs:style && npm run docs:links && npm run docs:ste`: passed.
- `npm run check`: The final pass completed 4,619 tests with 4 skips, the build, and 43 runtime tests with 34 skips.
- Public run 32445206680 proved both hosts and attestation, then failed before mutation at the unsupported administration query. No release or tag exists.
- Public protected-environment verification remains pending for the corrected workflow.

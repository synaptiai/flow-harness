# Decision journal: Issue #138 — Make preview verification pass on supported Ubuntu hosts

**Issue:** #138 | **Branch:** `codex/issue-138-ubuntu-preview-verification` | **Started:** 2026-08-21

## Context

Preview run 32437028440 prepared one revision-bound archive. macOS 15 Intel verified the installed
package. Ubuntu 24.04 rejected the credential-free workflow because the default native sandbox
could not find a trusted Bubblewrap executable. The run failed before attestation or publication.

## Decision

Prepare the supported Ubuntu verification host with the complete native-sandbox dependency set
that main CI and public guidance require. Keep the credential-free workflow sandboxed and keep both
platform jobs as prerequisites for attestation and publication.

## Acceptance verification map

| Criterion | Evidence command | Expected result |
| --- | --- | --- |
| The hosted Ubuntu consumer has the required native sandbox. | `npx vitest run test/scaffold/preview-release-workflow.test.ts` | The Linux-only prerequisite and namespace setting are bound before clean installation. |
| Public Ubuntu guidance is complete. | `npm run docs:style && npm run docs:links && npm run docs:ste` | The prerequisite and host-security effect are clear and linked from the install path. |
| Both platforms consume one archive before attestation. | The non-publication `Preview release` workflow | Ubuntu 24.04 x64 and macOS 15 Intel pass for the same artifact; attestation runs afterward. |

## Evidence

### Local

- `npx vitest run test/scaffold/preview-release-workflow.test.ts test/scaffold/community-files.test.ts test/integration/package/documentation-structure.test.ts test/scaffold/package.test.ts`: 42 tests passed across 4 files.
- `npm run docs:style && npm run docs:links && npm run docs:ste`: passed.
- `npm run check`: The command passed 4,619 tests with 4 skips, completed the build, and passed 43 runtime tests with 34 skips.
- `git diff --check`: passed.

### Hosted

- Hosted run 32441035269 passed macOS 15 Intel and the Ubuntu host-preparation step. Ubuntu then
  failed closed because the incomplete preview dependency set omitted required sandbox helpers.
- Hosted Ubuntu 24.04 x64 and macOS 15 Intel verification remains pending for the complete set.

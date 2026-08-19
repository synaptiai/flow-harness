# Decision Journal: Issue #125 — Bound and prune retired capability package blobs

**Issue**: #125 | **Branch**: `codex/issue-125-retired-package-blobs` | **Started**: 2026-08-19

---

## Specification

_Captured after the user approved Approach C, open-file pinning with explicit mutation-locked
mark-and-sweep maintenance._

### Non-goals

- Do not run maintenance automatically from the repository watcher, package installation, package
  replacement, workflow admission, or supervisor startup.
- Do not treat retired blobs as rollback, recovery, replay, or update authority.
- Do not add durable reader leases, a background garbage collector, time-based grace periods, or a
  second package mutation lock.
- Do not change active package limits, package identity rules, repository trust, Sigstore policy,
  durable workflow snapshots, or durable evaluation snapshots.
- Do not support Windows filesystems. The package store already requires local POSIX filesystem
  behavior for atomic rename, hard links, `fsync`, and no-follow access.
- Do not claim that unlinking a file immediately returns disk blocks to the host.
- Do not expose package contents, private paths, credentials, raw filesystem errors, or nested
  causes in public output.

### Failure modes

| Failure mode | Required behavior |
| --- | --- |
| Invalid, repeated, conflicting, or excessive CLI input | Reject before package-store reads or mutation with a fixed, value-free usage error |
| Missing store or no retired blobs | Return a deterministic empty preview; apply the exact empty plan without mutation |
| Stale or malformed plan digest | Reject before unlink with a fixed plan-mismatch stage |
| Active lock or blob set changes after preview | Recompute under mutation ownership and reject the stale plan before unlink |
| Active blob appears among deletion candidates | Fail closed before mutation |
| Linked, non-regular, unexpectedly named, oversized, duplicate, or inconsistent entry | Fail closed; do not classify the entry as reclaimable |
| Physical blob limit reached during install or replacement | Reject before blob publication and active-lock publication |
| Blob open fails before a reader pins a generation | Reopen the active lock and retry only when the lock changed; otherwise fail as corrupt |
| Lock changes after all active blob handles are open | Complete from the pinned generation and close every handle |
| Cancellation before deletion | Preserve the exact caller reason and change nothing |
| Cancellation after deletion starts | Finish the in-progress unlink and parent-directory settlement, then preserve the exact caller reason |
| Unlink or directory settlement failure | Stop with a fixed maintenance-settlement stage; never report a successful apply |
| Partial interrupted maintenance | Keep active authority unchanged; allow a fresh preview to describe only remaining retired blobs |
| File-descriptor exhaustion or handle close failure | Close every opened handle; preserve the primary read failure and report fixed settlement uncertainty when cleanup also fails |
| Missing context | Require an established project package store; an empty established store produces an empty plan |
| Timeouts | None — maintenance performs bounded local filesystem work and has no network operation or independent wall-clock timeout |

### Interface contracts

#### Command and output

- Preview command: `flow packages prune`.
- Apply command: `flow packages prune --apply --expected-plan-digest <sha256>`.
- `--apply` and `--expected-plan-digest` are required together. Duplicate or unexpected options are
  invalid.
- Preview output contains `status: "preview"`, `planDigest`, `retiredBlobCount`, and
  `retiredBlobBytes`.
- Apply output contains `status: "applied"`, `planDigest`, `unlinkedBlobCount`, and
  `unlinkedBlobBytes`.
- Public output does not list blob digests or paths. Byte fields describe logical bytes unlinked,
  not immediate free-space recovery.

#### Maintenance plan

- The versioned plan binds the exact active-lock digest and the sorted set of retired canonical
  blob digests with their verified byte lengths.
- The plan digest is the SHA-256 digest of the canonical JSON plan payload.
- Preview is read-only. Apply takes the existing package mutation lock, rebuilds the plan from
  reopened state, compares the exact digest, and only then unlinks candidates.
- Apply unlinks candidates in lexical digest order. Each successfully unlinked retired blob is
  independently safe and does not require rollback.
- After the first unlink, apply synchronizes the blob directory before returning success,
  cancellation, or a later failure.

#### Reader generations

- A package snapshot reader binds one active-lock generation, opens every referenced blob with
  no-follow semantics, and validates bytes, digest, identity, and metadata from the opened handles.
- Open handles pin the selected inode on supported POSIX filesystems. A later unlink does not alter
  the bytes returned by that reader.
- If a referenced blob cannot be opened and the active lock changed, the reader retries from the
  newer lock. If the lock did not change, the store is corrupt.
- A reader performs at most two generation attempts and closes every opened handle on every exit.

#### Storage bounds

- Active authority remains limited to 128 packages and 64 MiB of canonical bundle bytes.
- Physical blob storage is limited to 256 canonical blobs and 128 MiB.
- Install and replacement inspect physical blob state under mutation ownership and reject before
  publication when the resulting store would exceed either physical limit.
- Maintenance may inspect up to 512 canonical blobs and 256 MiB so an oversized legacy store can
  be repaired. State beyond the recovery limit fails closed and requires manual remediation.
- Unexpected directory entries are not included in a maintenance plan and cause the operation to
  fail closed.

#### Durable composition

- Workflow, supervisor, recovery, replay, child, and evaluation execution continue from frozen
  capability snapshots that contain the admitted package bytes.
- No durable run or evaluation record becomes a maintenance root in the live package store.
- The repository watcher keeps replacement non-destructive and never invokes maintenance.

## Decision

### Approved approach

**Approach C — open-file pinning with explicit mutation-locked mark-and-sweep.**

```text
reader                                      operator maintenance
  read one active lock                         preview active lock + blobs
  open every referenced blob                   return aggregate + plan digest
  validate from opened handles                 acquire package mutation lock
  complete from pinned inodes                   rebuild and compare exact plan
  close every handle                           unlink only retired canonical blobs
                                                 sync blob directory
```

The package store already depends on POSIX atomic filesystem behavior. An open file descriptor
keeps its inode available after the pathname is unlinked, so readers do not need a long-lived
mutation lock or a durable lease. The collector marks only the current active lock because durable
workflow and evaluation records already embed the complete admitted capability snapshot.

### Approaches considered

| Approach | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Stop-the-world reader lock | Simple proof; deletion cannot overlap admission | Every package admission holds the mutation lock while reading and verifying up to 64 MiB | Rejected |
| Durable reader leases and garbage-collection roots | Concurrent readers; explicit roots resemble Nix | Adds stale-lease recovery, clock and crash semantics, durable attack surface, and a second authority model | Rejected |
| Open-file pinning with mutation-locked mark-and-sweep | Concurrent snapshot reads; no persistent leases; composes with immutable blobs and existing lock | Requires generation retry, strict handle cleanup, and POSIX host evidence | **Selected** |
| Time-based grace period | Familiar Git-style operational model | Readers have no trusted maximum lifetime and clocks can roll back; age is not a correctness proof | Rejected |

### Standards and dependency cross-check

- POSIX specifies that removing the final directory link does not discard file contents while a
  process still has the file open.
- CNCF Distribution uses mark-and-sweep and requires mutation exclusion during collection. Flow
  uses its existing package mutation lock for the same authority boundary.
- Nix garbage-collection roots are unnecessary here because Flow durable runs and evaluations
  store the complete package snapshot rather than a live-store reference.
- Git grace periods are unsuitable because Flow readers do not have a trusted maximum duration and
  the security model rejects clock rollback.
- TUF and Sigstore authenticate package metadata and bytes. Neither standard defines local
  immutable-blob retention, so maintenance remains a Flow storage concern below trust admission.

## Plan

### Implementation slices

1. RED/GREEN a versioned deterministic preview and exact apply-plan contract, including fixed public
   output and stale-plan refusal.
2. RED/GREEN bounded no-follow physical blob inspection, unsafe-entry rejection, and install and
   replacement prepublication caps.
3. RED/GREEN generation-pinned package snapshot reads, bounded retry, and complete handle
   settlement across success, failure, and cancellation.
4. RED/GREEN mutation-locked ordered unlink, parent-directory settlement, partial-failure recovery,
   and exact cancellation precedence.
5. Compose the application port and CLI grammar without adding watcher or supervisor authority.
6. Update the canonical operator guide, sourcing contract, recovery runbook, architecture diagram,
   testing guide, roadmap, project status, and concise README routing only when necessary.

## Verification map

| Criteria | Type | Verification command | Required evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–2, 8–9 | Behavioral/error | `npx vitest run test/unit/application/capability-package-storage.test.ts test/integration/cli/capability-packages.test.ts` | Deterministic preview, exact plan digest, apply confirmation grammar, stale-plan refusal, aggregate output, and privacy | Automatic maintenance or free-space measurement |
| 3–4 | Concurrency/data | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts test/unit/capability/installed-capability-catalog.test.ts` | Open-handle pinning, exact generation reads, lock-change retry, unchanged-lock corruption, complete handle closure, cancellation ordering, and active-blob preservation | Remote or distributed filesystems |
| 5–6 | Bounds/security | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts` | Exact physical count and byte limits, limit+1 refusal before publication, no-follow entry grammar, hard-link rejection, and oversized legacy recovery bound | Repair beyond the recovery scan limit |
| 7–8 | Cancellation/recovery | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts test/integration/cli/capability-packages.test.ts` | Pre-delete exact cancellation, post-delete directory settlement, unlink and sync failure stages, ordered partial progress, and safe fresh preview | Transactional restoration of retired blobs |
| 3, 10 | Offline regression | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Attached, detached, child, recovery, replay, and evaluation paths retain frozen package bytes after retired-path removal | Migration of corrupt historical snapshots |
| 10 | Documentation/static | `npm run docs:style && npm run docs:links && npm run docs:ste && npm run typecheck && npm run lint && npm run format:check && git diff --check` | Public command, limits, recovery, architecture, roadmap, and test documentation agree with source and style policy | Runtime behavior |
| 10 | POSIX/runtime | `npm run build && npm run test:runtime && npm run test:browser && npm run pack:check` | Compiled CLI, runtime integrations, browser regression, and packaged CLI pass on the supported host | Hosted Linux x64 Docker behavior |
| 10 | Release/host | `npm run test:coverage` plus hosted Linux x64 CI | Complete serial suite, coverage thresholds, and exact Linux x64 filesystem behavior pass | Future Node, Docker, or filesystem versions |

## Evidence

### TDD and review evidence

- RED tests first established missing preview and apply behavior, physical and recovery bounds,
  unsafe-entry rejection, generation retry, pinned-reader behavior, cancellation ordering, partial
  settlement, empty-store behavior, and exact CLI grammar.
- An adversarial full-suite run found that bundle-read cancellation returned before closing a
  pinned generation handle. A focused RED test reproduced the lifecycle defect. The final reader
  captures cancellation, closes all retained handles, and then restores the exact caller reason.
  A second regression proves that handle-settlement uncertainty takes precedence when cancellation
  and cleanup fail together.
- The exact mapped acceptance selector passed 231 tests across these eight files:
  `test/unit/application/capability-package-storage.test.ts`,
  `test/unit/infrastructure/fs/local-capability-package-store.test.ts`,
  `test/unit/capability/installed-capability-catalog.test.ts`,
  `test/integration/cli/capability-packages.test.ts`,
  `test/integration/cli/remote-capability-workflow.test.ts`,
  `test/integration/supervisor/service.test.ts`,
  `test/integration/supervisor/worker.test.ts`, and
  `test/integration/package/architecture-documentation.test.ts`.

Run the mapped selector with:

```sh
npx vitest run \
  test/unit/application/capability-package-storage.test.ts \
  test/unit/infrastructure/fs/local-capability-package-store.test.ts \
  test/unit/capability/installed-capability-catalog.test.ts \
  test/integration/cli/capability-packages.test.ts \
  test/integration/cli/remote-capability-workflow.test.ts \
  test/integration/supervisor/service.test.ts \
  test/integration/supervisor/worker.test.ts \
  test/integration/package/architecture-documentation.test.ts
```

### Repository gates

- `npm run test:coverage` passed 4,388 tests across 317 files. Four tests and one file were skipped
  by their declared platform conditions. Coverage was 84.54% statements, 78.94% branches, 91.17%
  functions, and 84.67% lines. Vitest reported no unhandled errors.
- `npm run format:check`, `npm run lint`, `npm run docs:style`, `npm run docs:links`,
  `npm run docs:ste`, `npm run typecheck`, `npm run build`, and `git diff --check` passed. Lint
  retained one informational finding in the unchanged external harness adapter and reported no
  error or warning.
- `npm run test:runtime` passed 43 portable runtime tests and skipped 34 platform-specific tests.
  `npm run test:browser` passed two tests. `node scripts/smoke-compiled.mjs` passed against the
  rebuilt distribution.
- `npm run pack:check` verified clean installation and CLI execution from
  `synaptiai-flow-harness-0.0.0.tgz` with SHA-256 digest
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.
- The Prime dependency audit passed for the Node lock and 60 Python packages. The production npm
  audit found zero vulnerabilities.

### Hosted acceptance boundary

`npm run ci:local` passed every preliminary gate on macOS and then stopped at its intentional
Linux-x64 guard before Prime OCI runtime preparation. The platform-portable verified gates were
run separately and passed as recorded above. Hosted Linux x64 CI must still run the exact Prime
preparation, Docker, and POSIX acceptance paths before merge.

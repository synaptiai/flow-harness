# Decision Journal: Issue #115 — Atomically replace an established capability bundle from a reviewed repository candidate

**Issue**: #115 | **Branch**: `codex/issue-115-atomic-package-replacement` | **Started**: 2026-08-18

---

## Specification

_Captured by specification-capture skill on 2026-08-18. Source: extracted-from-issue and the user-approved refined TUF program._

### Non-goals

- Do not automatically check a repository or replace a bundle on a schedule in this issue.
- Do not install the first trusted version without explicit operator activation.
- Do not replace policy packages, change the contained capability identity surface, or activate executable extension code.
- Do not automatically select a workflow, tool, verifier, presentation, policy, or Agent Skill for an existing workflow or run.
- Do not add automatic rollback, private repository credentials, online trust bootstrap, mutable OCI tags, or online Sigstore trust-root refresh.
- Do not change execution-supervisor, sandbox, provider-session, ACP, AG-UI, A2UI, or remote-host contracts.

### Failure modes

- **Timeouts** — A pre-commit deadline returns its exact reason and leaves the established generation active.
- **Partial failures** — Pre-commit failure preserves the old generation, post-rename failure reports uncertainty, and later cleanup cannot roll back a commit.
- **Invalid input** — Invalid, stale, corrupt, linked, oversized, or changed input fails through a fixed stage before mutation.
- **Missing context** — Missing project, generation, candidate, established version, metadata, or publisher authority yields a fixed error without mutation.

### Interface contracts

- Replacement input identifies one reviewed candidate digest, the expected current version, and the exact certificate authority.
- Replacement returns `already_current`, a settled result with cleanup evidence, or a fixed failure.
- The package mutation boundary validates both bundle identities and publishes one lock generation under the existing single-writer authority.
- Repository authentication and package mutation remain separate, so repository evidence cannot bypass any package or recovery gate.
- Durable runs and evaluations consume admitted snapshots, while replacement affects only future capability discovery.

## Decision

### Approved program

The user approved a two-issue TUF program:

1. Add explicit transactional replacement for an already established capability bundle.
2. Add an opt-in repository watcher that can use the settled replacement operation without overlapping checks or widening supervisor authority.

This issue implements only the first step.

### Approaches considered

1. **Remove then install** — Rejected because a crash can expose a generation with neither version active.
2. **Install then remove** — Rejected because capability discovery can observe duplicate identities and fail before cleanup.
3. **Immutable new blob plus one atomic lock-generation replacement** — Selected. Readers observe the old or new generation. Frozen runs remain independent. Cleanup follows authority settlement.

### Standards cross-check

- TUF authenticates repository targets but intentionally leaves application update policy and file activation to the integrating application.
- Nix profiles independently show the same storage pattern: immutable content plus one atomic active-generation switch.
- Flow keeps its own stricter Sigstore, current-metadata, package-schema, capability-identity, snapshot, cancellation, and recovery gates.

## Plan

1. Define a bounded replacement projection that rejects policy packages, authority drift, rollback, identity changes, and tool-surface changes.
2. Add one replacement operation that publishes an immutable blob and atomically replaces one lock entry.
3. Reopen and authenticate the reviewed candidate and its complete TUF generation with offline Sigstore verification.
4. Add an explicit CLI command with an exact current version and publisher authority, separate from first activation.
5. Bind durable snapshot isolation and future admission behavior, then update the affected public documents.
6. Run focused, full, coverage, build, runtime, package, documentation, and adversarial review gates.

## Verification map

| Criterion | Verification command | Required evidence | Does not promise |
| --- | --- | --- | --- |
| 1, 3, 4 | `npx vitest run test/unit/domain/capability/capability-bundle-replacement.test.ts` | Exact SemVer precedence, policy rejection, publisher continuity inputs, and a mutation table over every capability-surface leaf | Scheduler behavior or automatic selection |
| 2 | `npx vitest run test/unit/application/replace-capability-repository-candidate.test.ts test/unit/infrastructure/fs/local-capability-repository-store.test.ts` | Reopened generation authentication, envelope and Sigstore re-verification, and zero package mutation for changed evidence | Online refresh during replacement |
| 1, 5, 7, 8, 9 | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts` | `replaced` and `already_current`, old-or-new reader observations, serialized mutation, exact cancellation, post-commit uncertainty, cleanup reporting, and primary-error precedence | Automatic garbage collection outside the replaced blob |
| 6 | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Existing attached, detached, child, recovery, replay, and evaluation state retain frozen package bytes while later admission observes only the new generation | Migration of already-admitted durable state |
| 1, 7, 10 | `npx vitest run test/integration/cli/capability-repository.test.ts` | Explicit offline replacement, idempotent repeat, fixed portable public output, and absence of private evidence | Background repository polling |
| 11 | `npm run docs:ste && git diff --check` | All named public documents and this journal agree with implemented behavior and recovery | A future scheduler design |
| 12 | `npm run typecheck && npm run lint && npm run format:check && npm run test -- --run && npm run test:coverage && npm run build && npm run test:runtime && npm run pack:check` | Full frozen-tree release evidence, including coverage and packaged-artifact verification | Hosted environment availability beyond recorded gates |

# Decision Journal: Issue #117 — Watch one TUF repository package for bounded atomic updates

**Issue**: #117 | **Branch**: `codex/issue-117-tuf-package-watcher` | **Started**: 2026-08-18

---

## Specification

_Captured from Issue #117 and the user-approved refined TUF program._

### User, operator, and system flows

1. **Operator start** — The operator names one installed bundle and one exact Sigstore publisher.
   The input also sets a bounded interval and update policy. Flow acquires one project-local owner
   record and emits a fixed startup status.

2. **Scheduled reconciliation** — Flow waits one complete interval. It reopens current installed
   state and performs one ordinary TUF repository check. It selects the highest admissible candidate.
   It then invokes the existing offline atomic replacement operation.

3. **No update** — Flow can find no candidate that matches the name, publisher, and update policy.
   It emits a fixed no-update or policy-blocked status. It then waits another complete interval.

4. **Settled update** — A settled replacement or exact repeat emits its portable package result and
   waits another complete interval. Existing runs continue from frozen snapshots.

5. **Failure or cancellation** — Ordinary check failure is observable and may be followed only by a
   new full interval. Clock rollback, ownership uncertainty, replacement failure, or commit
   uncertainty stops. Operator cancellation remains exact. Flow settles owned boundaries first.

### Non-goals

- Do not install the first trusted package version automatically.

- Do not update major versions, policy packages, publisher identity, capability surface, tools,
  requested authority, workflows, or durable runs automatically.

- Do not add a hidden background daemon, supervisor updater, multi-package transaction, or remote
  controller.

- Do not add private repository credentials, online root bootstrap, online Sigstore trust refresh,
  mutable tags, rollback, or executable extensions.

- Do not delete repository candidates, retired package blobs, frozen run snapshots, evaluation
  evidence, or rollback material.

- Do not claim that a cooperative lease resists a hostile filesystem writer.

### Failure modes

| Failure mode | Required behavior |
| --- | --- |
| Invalid interval, policy, name, or publisher | Reject before ownership, network, or package mutation |
| Missing or changed installed baseline | Stop with a fixed reconciliation stage and no first install |
| TUF transport, metadata, target, or storage failure | Emit one fixed `check_failed` cycle and wait a new full interval |
| No matching candidate | Emit fixed `no_update`; do not call replacement |
| Candidate outside automatic version policy | Emit fixed `policy_blocked`; do not call replacement |
| Replacement validation or pre-commit failure | Stop; do not retry automatically |
| Replacement commit uncertainty | Stop with replacement as primary; require operator inspection |
| Clock rollback | Emit fixed clock status and stop before later work |
| Concurrent watcher | Fail before check; never wait for or steal live ownership |
| Corrupt, linked, replaced, or unsettled ownership | Fail closed with fixed remediation; do not unlink automatically |
| Cancellation | Preserve exact reason before later phases; after an owned mutation, settle that operation first |
| Observer or public-output failure | Stop rather than continue invisible automatic mutation |
| Resource exhaustion | Bound interval, candidates, statuses, owner record, and one active cycle; retain no response bodies |

### Interface contracts

- Watch input contains one package name, exact publisher policy, bounded interval, and update policy.
  It also contains an abort signal and optional prior durable check high-water time.

- `patch` is the default automatic policy. `minor` must be explicit. Major transitions are rejected.

- One reconciliation reads the active baseline and consumes one settled check publication. It
  chooses at most one deterministic candidate. It invokes only the existing replacement boundary.

- Scheduler status and reconciliation status are distinct closed records. Neither record is an
  authorization token.

- The foreground CLI owns process signals, status serialization, concrete stores, TUF client, and
  local watcher ownership. The application controller imports no infrastructure implementation.

## Architecture

### Components and dependency direction

```text
CLI composition
  -> local watcher ownership adapter
  -> application repository scheduler
  -> application watcher reconciler
       -> installed package state reader port
       -> existing TUF checker port
       -> existing repository replacement port
       -> fixed status observer port

existing TUF checker -> repository store + strict HTTPS fetcher + offline Sigstore
existing replacer   -> repository reopen + package mutation store
```

The watcher adds no domain-to-infrastructure dependency, no supervisor import, no global mutable
state, and no second package mutation implementation. Package and repository stores retain their
existing independent single-writer locks.

### Approaches considered

| Approach | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Foreground single-package watcher | Reuses settled scheduler/check/replacement boundaries; explicit lifecycle and cancellation; smallest authority surface | Operator must arrange service persistence; one process per package | **Selected** |
| External timer plus one-shot reconcile | No resident Flow process; easy to host with system timers | Every deployment must recreate restart-gap, no-overlap, clock, and status behavior; inconsistent automation surface | Deferred |
| Supervisor-integrated multi-package controller | Central status and one durable service | Grants run supervisor package/network mutation authority; expands authentication, crash recovery, and cross-package atomicity | Rejected for this step |

### Standards cross-check

- The TUF client workflow requires aborted updates to remain recoverable. Flow keeps check and
  replacement separate. It never retries an uncertain mutation.

- The controller pattern separates desired policy from observed actual state. The watcher input is
  desired policy. Package and repository stores provide actual state on every cycle.

- Immutable-store garbage collection requires complete roots. Flow has durable frozen package
  snapshots but no complete reader-root index. Replacement therefore retains old blobs. Automatic
  maintenance remains a separate design.

## Plan

1. RED/GREEN a pure automatic-update policy and deterministic candidate selector.

2. RED/GREEN a one-cycle application reconciler that preserves phase order, cancellation, fixed
   status, and stop-vs-continue semantics.

3. RED/GREEN cooperative project-local watcher ownership with no-follow bounded records and
   fail-closed stale-state remediation.

4. Compose the existing scheduler and reconciler in a foreground CLI command. Require exact
   grammar, JSON Lines output, signal cleanup, and durable restart high-water.

5. Prove frozen attached/detached/recovery/evaluation behavior and no supervisor/package authority
   widening, then update all named public documents.

6. Run focused, full, coverage, build, runtime, package, supply-chain, and documentation gates. Run
   the hosted Linux x64 gates. Perform adversarial Flow review before merge.

## Verification map

| Criteria | Type | Verification command | Required evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 4–7 | Behavioral/data | `npx vitest run test/unit/application/capability-repository-watcher.test.ts test/unit/application/replace-capability-repository-candidate.test.ts test/unit/domain/capability-bundle-replacement.test.ts` | Exact baseline and publisher binding; patch/minor bounds; deterministic unambiguous highest candidate; zero mutation for missing, unrelated, ambiguous, equal, lower, major, policy-bearing, or capability-expanding input; replacement errors stop | Multi-package transactions or first install |
| 2, 8–10 | Behavioral/error | `npx vitest run test/unit/application/capability-repository-scheduler.test.ts test/unit/application/capability-repository-watcher.test.ts` | Full-interval/no-overlap order, restart gaps, clock rollback, check-failure continuation, replacement-failure stop, exact cancellation, observer precedence | Host service restart policy |
| 3, 9 | Concurrency/recovery | `npx vitest run test/unit/infrastructure/fs/local-capability-repository-watcher-lock.test.ts` | One owner, linked/corrupt/replaced state rejection, bounded record, cancellation, release settlement, no automatic stale deletion, private-value exclusion | Hostile same-user filesystem isolation |
| 1, 5, 8, 10, 12 | CLI/integration | `npx vitest run test/integration/cli/capability-repository.test.ts` | Exact grammar/defaults, real check and offline replace composition, JSONL statuses, restart high-water, signal settlement, no first install, no private output | A packaged OS service unit |
| 11 | Regression/recovery | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts test/integration/cli/agent-skill-candidate.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Attached, detached, child, recovery, replay, and evaluation snapshots remain frozen across replacement | Migration of already-admitted state |
| 13–14 | Documentation/release | `npm run docs:ste && npm run typecheck && npm run lint && npm run format:check && git diff --check` | Public behavior, non-goals, fixed errors, and verification map agree with source; static gates pass | Full runtime or hosted-platform behavior |
| 15 | Release | `npm run test -- --run && npm run test:coverage && npm run build && npm run test:runtime && npm run test:browser && npm run pack:check` | Complete frozen-tree suite, coverage, clean compiled runtime, browser regression, and packaged CLI execution pass | Environments not represented by local and hosted gates |

## Evidence

The frozen local tree passed the exact mapped selector with **141 tests across 10 files**:

```text
npx vitest run \
  test/unit/application/capability-repository-watcher.test.ts \
  test/unit/application/replace-capability-repository-candidate.test.ts \
  test/unit/domain/capability-bundle-replacement.test.ts \
  test/unit/application/capability-repository-scheduler.test.ts \
  test/unit/infrastructure/fs/local-capability-repository-watcher-lock.test.ts \
  test/integration/cli/capability-repository.test.ts \
  test/integration/cli/remote-capability-workflow.test.ts \
  test/integration/cli/agent-skill-candidate.test.ts \
  test/integration/supervisor/service.test.ts \
  test/integration/supervisor/worker.test.ts
```

The complete serial suite passed **4,235 tests**, with the four established platform tests skipped.
Coverage passed at 84.39% statements, 78.69% branches, 91.08% functions, and 84.52% lines.
The watcher module measured 94.87% statements and lines, 87.5% branches, and 100% functions.

The clean build passed. The compiled runtime suite passed 43 tests and skipped 34 platform tests.
The browser suite passed two tests. The package installation, browser, and Prime-boundary check
passed. TypeScript, lint, formatting, STE, and diff checks passed.

The Prime dependency audit passed for the Node lock and 60 Python packages. The root production
dependency audit reported zero vulnerabilities.
The local package check needed a browser URL deadline of 15 seconds. The same packaged browser
scenario consistently completed in about 6 seconds. The bound remains fixed.

The macOS compiled smoke command reached the compiled CLI. It completed its Node-version node. The
nested Anthropic Sandbox Runtime did not complete `tsc --noEmit` within the fixed 120-second limit.
Direct TypeScript checking and the compiled runtime suite pass. The workflow deadline was not
weakened.

Hosted Linux x64 CI remains the platform acceptance gate. It must pass before merge.

The adversarial review found and fixed four issues before publication. They covered cancellation
precedence, publisher preflight, SemVer ambiguity, and default/boundary evidence. No known P1, P2,
or P3 finding remains in the frozen local tree.

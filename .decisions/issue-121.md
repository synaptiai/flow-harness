# Decision Journal: Issue #121 — Activate one exact repository package automatically when it becomes available

**Issue**: #121 | **Branch**: `codex/issue-121-exact-first-activation` | **Started**: 2026-08-18

---

## Specification

_Captured after the user approved A1, the one-shot exact first-activation approach._

### Non-goals

- Do not bootstrap a repository root online or trust a root on first use.
- Do not authorize a version range, publisher transition, major update, policy package, executable extension, or mutable target.
- Do not add a background daemon, supervisor updater, multi-package transaction, automatic rollback, or package garbage collection.
- Do not turn a successful first activation into continuing reinstall or update authority.
- Do not change the existing foreground watcher, replacement policy, supervisor, run, recovery, replay, child, or evaluation contracts.
- Do not expose private repository responses, target paths, signatures, credentials, filesystem values, or nested causes.

### Failure modes

| Failure mode | Required behavior |
| --- | --- |
| Invalid, repeated, conflicting, or excessive input | Reject before configuration, repository, state, or package work |
| Repository not initialized from an explicit root | Reject before activation-state or package mutation |
| Conflicting installed package | Reject before repository access or mutation |
| Missing candidate | Consume one bounded attempt, emit a fixed status, and wait a new full interval only when attempts remain |
| Ambiguous exact candidates | Stop with a fixed selection stage and no mutation |
| TUF check failure | Consume one bounded attempt, emit a fixed status, and wait a new full interval only when attempts remain |
| Candidate authority, bundle, metadata, or package-policy drift | Stop before mutation with a fixed stage |
| Missing or inactive Flow metadata | Reject at the package mutation boundary; never use explicit-install bootstrap behavior |
| Cancellation or deadline before mutation ownership | Preserve the exact reason and start no later phase |
| Cancellation after package commit | Settle the exact durable receipt before preserving the caller reason |
| Package commit uncertainty | Reopen installed state; settle only an exact prepared receipt, otherwise stop as uncertain |
| Activation-state commit uncertainty | Reopen the state and continue only when the exact requested transition is durable |
| Clock rollback | Emit a fixed status and stop before a later check or mutation |
| Observer failure | Stop; after package commit, settle the receipt before reporting failure |
| Settled package later removed | Reject without repository access or reinstallation |
| Corrupt, linked, replaced, oversized, or unsettled durable state | Fail closed with fixed remediation; do not infer authority |
| Ownership conflict or release failure | Run no overlapping attempt; preserve the primary operation outcome and report fixed settlement failure |

### Interface contracts

#### Command and output

- Public command: `flow packages repository first-activate <bundle-name> --version <exact> --max-checks <1..1000> [--interval-ms <60000..86400000>] --certificate-issuer <https-url> --certificate-identity <exact>`.
- The default interval is one hour, but the command has no default attempt limit.
- The command waits one complete interval before every repository check, including the first.
- Public output is newline-delimited fixed status records. The terminal result is `activated`, `already_activated`, or `attempts_exhausted`. Failures use fixed value-free stages.

#### Durable records

- The durable operation identity binds only the exact package name, exact version, and exact publisher. Scheduling options cannot mint a second authority for the same package identity.
- A pending record binds the complete authorization, scheduling policy, consumed attempts, and trusted clock high-water.
- A prepared record also binds candidate digest, check time, target source, bundle identity, and the Sigstore receipt.
- A settled record binds the same prepared receipt and the exact installed package result. It remains durable after later package removal.

#### Composition

- A metadata-required package-install port is distinct from explicit bootstrap installation. It checks current active metadata under the existing package mutation lock immediately before publication and again at commit.
- The application controller depends only on ports. They cover state, package inspection, repository checks, candidate reopen, strict install, clock, waiting, and observation. The controller imports no local filesystem or network implementation.
- The shared foreground owner prevents overlap between first activation and continuous watching.

## Decision

### Approved approach

**A1 — one-shot exact first activation with durable intent and settlement.**

```text
exact name + exact version + exact publisher
  -> durable waiting intent
  -> full bounded interval
  -> one ordinary TUF check
  -> exactly one matching candidate
  -> offline Sigstore + bundle reopen
  -> inert-package and active-metadata gates
  -> durable prepared receipt
  -> metadata-required package install
  -> durable settled receipt
  -> fixed result and termination
```

### Approaches considered

| Approach | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| One-shot exact activation with durable receipt | Narrow consumable authority; deterministic recovery; no continuing reinstall right | Adds a small durable lifecycle and finite scheduler | **Selected** |
| Extend the continuous watcher to permit a missing baseline | Reuses its loop and output | Conflates first-install and update policy; settled removal can become reinstall authority | Rejected |
| External timer repeatedly invoking explicit activation | Minimal in-process scheduling | Recreates no-overlap, attempt accounting, restart, clock, and commit reconciliation differently in each deployment | Deferred |
| Supervisor-owned repository automation | Central lifecycle and status | Widens run-supervisor network and package mutation authority | Rejected |

### Standards and dependency cross-check

- TUF authenticates metadata and target bytes but leaves target selection and activation to the application. A1 is therefore an application authorization layered after TUF verification.
- Sigstore publisher verification remains offline and exact. A1 stores only the verified receipt needed for reconciliation. It does not refresh trust roots online.

- Atomic immutable-package publication remains the package-store responsibility. A1 records intent around that boundary rather than implementing a second package mutation path.
- The existing watcher remains the compatible-update controller for an already-established package. A1 terminates and grants no later update authority.
- ACP, A2UI, A2A, and AG-UI do not supply this package-activation policy boundary. Run and presentation protocols remain consumers of frozen active package snapshots only.

## Plan

### Implementation slices

1. RED/GREEN the exact authorization parser, candidate selector, finite scheduling, fixed statuses, and installed-state reconciliation.
2. RED/GREEN a bounded no-follow durable waiting/prepared/settled store with atomic transition and uncertainty evidence.
3. RED/GREEN metadata-required package installation under the existing mutation lock without changing explicit bootstrap installation.
4. Compose the controller, repository checker, candidate reopener, strict installer, shared automation ownership, and exact CLI grammar.

### Verification slices

5. Prove settled removal never reinstalls and that attached, detached, child, recovery, replay, and evaluation paths ignore automation state.
6. Keep README, roadmap, architecture, sourcing, recovery, and testing documentation synchronized. Run all release and hosted Linux x64 gates. Perform adversarial review.

## Verification map

| Criteria | Type | Verification command | Required evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–2, 4–5, 8–12 | Behavioral/error | `npx vitest run test/unit/application/capability-repository-first-activation.test.ts` | Exact authorization; full waits; finite attempts; deterministic candidate selection; conflict-before-check; inert-only policy; fixed statuses; observer and clock behavior | Filesystem settlement |
| 6–7, 9–14 | Data/atomicity | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts test/unit/application/activate-capability-repository-candidate.test.ts` | Active metadata is mandatory under the mutation lock; exact idempotence; precommit absence; postcommit reopen and settlement | Repository polling |
| 12–16 | Recovery/concurrency | `npx vitest run test/unit/infrastructure/fs/local-capability-repository-first-activation-store.test.ts test/unit/infrastructure/fs/local-capability-repository-watcher-lock.test.ts` | Bounded no-follow records; waiting/prepared/settled transitions; exact/+1 bounds; cancellation; uncertainty; no-overlap; settled removal cannot mint authority | Hostile same-user filesystem isolation |
| 1–17 | CLI/integration | `npx vitest run test/integration/cli/capability-repository.test.ts` | Exact grammar; initialized-root requirement; real check/reopen/strict-install composition; JSONL statuses; finite exhaustion; restart reconciliation; existing watcher unchanged | A packaged OS service unit |
| 18 | Regression/recovery | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts test/integration/cli/agent-skill-candidate.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Attached, detached, child, recovery, replay, and evaluation remain frozen and ignore automation records | Migration of already-admitted state |
| 19 | Documentation/static | `npm run docs:ste && npm run typecheck && npm run lint && npm run format:check && git diff --check` | Public authority, lifecycle, recovery, remediation, non-goals, and exact commands agree with source | Runtime behavior |
| 20 | Release | `npm run test -- --run && npm run test:coverage && npm run build && npm run test:runtime && npm run test:browser && npm run pack:check` | Complete frozen-tree suite, coverage, clean compiled runtime, browser regression, and packaged CLI pass | Unrepresented platforms |
| 20 | Supply chain/host | `node scripts/audit-prime-dependencies.mjs && npm audit --omit=dev --audit-level=low` plus hosted Linux x64 CI | Dependency audit and exact-host gates pass | Future dependency or host versions |

## Evidence

Implementation evidence is intentionally empty until each RED/GREEN/REFACTOR slice and the final frozen-tree gates run.

# Decision Journal: Issue #107 — Standards-based capability package updates

**Issue**: #107 | **Branch**: `codex/issue-107-tuf-package-updates` | **Started**: 2026-08-17

---

## Status

The operator approved Approach A. The implementation is complete on merged `main` commit
`9b70a7d4b8891d67003c66b240ea4bb094da78fb`. The focused acceptance, complete repository,
coverage, runtime, package, production dependency, documentation, and formatting gates pass.

## Context

Flow can verify one signed capability metadata envelope and stage inert metadata candidates. It can
activate one reviewed metadata candidate, fetch exact HTTPS or OCI bundles, verify Sigstore
publisher evidence, and install content-addressed packages. It does not have repository roles,
threshold trust, root rotation, delegated targets, timestamp freshness, snapshot consistency, or
consistent target downloads.

Issue #107 adds those repository protections without moving package, policy, execution, or
activation authority into a network client or third-party cache.

## External evidence

- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)
  defines root, timestamp, snapshot, targets, delegated targets, consistent snapshots, and the
  client update workflow. Flow follows this workflow through an independently maintained client.

- [TUF conformance results](https://theupdateframework.github.io/tuf-conformance/) report the
  behavior of current client implementations against one shared suite.

- [tuf-js](https://github.com/theupdateframework/tuf-js) 6.0.0 supports Flow's Node 26 runtime.
  Its public `Updater` implements the standard refresh and delegated-target lookup workflow.

- The official tuf-js conformance run
  [31571886423](https://github.com/theupdateframework/tuf-js/actions/runs/31571886423) passed 107
  tests. The only expected failure was `test_artifact_cache`. Flow does not use the tuf-js target
  cache as durable or package authority.

- [Sigstore bundles](https://docs.sigstore.dev/about/bundle/) remain the package publisher proof.
  A repository signature does not replace the existing offline Sigstore verification.

## Architecture alternatives

The comparison weights protocol correctness 25%, Flow boundary safety 25%, standard reuse 15%,
portability 15%, maintainability 10%, and testability 10%.

| Approach | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| A. tuf-js in disposable Flow staging | 4.478 | Public standard client with strong boundary isolation | Requires translation and reopening of staged output | **Selected** |
| B. python-tuf subprocess | 3.635 | Complete reference behavior and conformance | Adds Python, IPC, and a second runtime contract | Rejected |
| C. tuf-js internal store orchestration | 4.150 | More direct control over persistence and time | Depends on non-public workflow details | Rejected |
| D. Native Flow TUF client | 3.480 | Exact control over every boundary | Duplicates a security protocol and its maintenance burden | Rejected |

A fixed-seed sensitivity check sampled 100,000 randomized criterion weights and score ranges.
Approach A won 89.6% of samples. Approach C won 8.3%, Approach D won 2.0%, and Approach B won
0.1%. The fifth-percentile winning margin for Approach A was 0.035. The result supports the
choice, but it does not prove it because the score ranges are judgments.

## Selected architecture

### Standard client containment

Flow uses tuf-js `Updater` only inside a private disposable staging directory. One isolated
compatibility import reads the package's internal HTTP and length error classes. The public fetcher
contract does not export the status error that `Updater` requires for 403 and 404 root termination.
The dependency is pinned, and a dependency-boundary test protects this exception.

- Flow copies the exact previously trusted metadata into staging.
- Flow supplies a strict per-operation fetcher. The default tuf-js fetcher is never used.
- Flow sets explicit role, rotation, byte, deadline, and retry limits. Retry is disabled.
- tuf-js may write only inside the disposable staging directory.

- Flow reopens every staged file with its own no-follow and bounded readers.
- Flow translates verified metadata into stable Flow domain records.
- Only a Flow store can publish durable repository state or candidates.
- tuf-js cache paths, errors, and internal classes never enter public or durable contracts.

This boundary also contains the upstream artifact-cache conformance exception.

### Repository layout

One configured repository has two canonical public HTTPS bases:

```text
<base>/metadata/
<base>/targets/
```

The operator supplies one explicit local trusted root during initialization. Flow does not learn a
root from either network base. The repository must use consistent snapshots.

The known logical index target is:

```text
flow/capability-index.json
```

The index is strict canonical JSON. It contains at most 64 unique entries. Each entry contains one
portable package name, semantic version, and logical package target path. tuf-js resolves the index
and every package path through the standard delegated-target traversal.
This Flow client accepts at most four selected entries per check. A larger selection rejects after
index authentication and before any package target download.

Each package target is one strict canonical signed-package envelope:

```text
apiVersion: flow.synapti.ai/v1alpha1
kind: SignedCapabilityBundleEnvelope
capabilityBundleBase64: <canonical padded base64>
sigstoreBundleBase64: <canonical padded base64>
```

The verified TUF target custom field is strict and contains:

```text
flow.apiVersion
flow.kind = CapabilityPackageTarget
flow.name
flow.version
flow.publisher.certificateIssuer
flow.publisher.certificateIdentity
```

Flow cross-binds the index entry, target path, target descriptor, custom metadata, envelope,
parsed capability bundle, Sigstore result, and candidate identity. Unknown fields, duplicates,
unsupported hashes, duplicate delegated-role names, and identity differences reject. Ordered
overlapping delegation paths retain standard preorder trust semantics. Duplicate role declarations
are ambiguous and reject. URL-encoded delegated role names retain the exact tuf-js storage identity
during offline replay.

### Layered package authority

TUF answers: "Which target bytes does this repository currently authorize?"

Sigstore answers: "Which package publisher signed these exact bundle bytes?"

Active Flow metadata answers: "May this exact package identity, source, and publisher be installed?"

The package store remains the final mutation owner. Repository checks can stage a candidate even
when active metadata does not yet authorize installation. Explicit candidate activation reopens
all evidence and calls the existing package store. The store rejects a package that does not match
the current Flow metadata target. If no active metadata exists, the existing bootstrap behavior
remains unchanged.

The source identity is the exact canonical consistent-snapshot HTTPS target URL. Flow permits this
HTTPS source to carry verified publisher evidence. Existing unsigned HTTPS and signed OCI paths
retain their current behavior.

### Durable repository state

Flow stores immutable content-addressed metadata, target envelopes, and candidate records. One
small current-generation record names the visible verified state and candidate set. The record is
published by one atomic rename after all content is durable.

- A pre-commit failure exposes no new generation or candidate.
- A post-rename settlement failure reports a fixed uncertain-commit stage.
- The next operation reconciles the current record before network access.
- At most four inert candidates and two repository generations are retained.
- Existing lock or pending state fails closed and requires documented operator remediation.
- Candidate bytes never enter the active package blob or lock before explicit activation.

The state records the accepted wall-clock instant. A later refresh or candidate reopen rejects when
the host clock is earlier than that instant. A check also brackets untrusted refresh and package
verification with a second clock observation immediately before publication. This prevents a local
clock rollback from making expired metadata appear current.

## Specification

### Non-goals

- Do not activate, install, execute, roll back, delete, or replace a package during repository
  initialization or checking.
- Do not let TUF signatures replace package schema, digest, Sigstore publisher, or active metadata.
- Keep policy package, approval, evaluation, and durable snapshot checks independent.
- Do not infer a trusted root, repository credential, mirror, or private endpoint.
- Do not persist tuf-js cache layout, objects, errors, or internal types as Flow authority.

- Do not add activation, startup checks, online Sigstore refresh, ACP, AG-UI, or A2UI integration.
- Do not add executable extensions.

### Failure modes

- **Root transition failure.** Missing, skipped, expired, rolled-back, or insufficiently signed
  roots leave the prior Flow generation current.
- **Repository metadata failure.** Expired, rolled-back, substituted, excessive, or inconsistent
  timestamp, snapshot, targets, or delegated roles publish no state.
- **Target failure.** Reject any missing, ambiguous, excessive, mismatched, or malformed target.
  An invalid index, descriptor, custom field, envelope, bundle, or publisher proof publishes no candidate.
- **Clock failure.** Any clock rollback during refresh fails closed.
  Invalid time also fails closed.

- **Cancellation or deadline.** The exact operator reason wins before durable ownership. Deadline
  and fixed stage errors remain value-free. After commit ownership, settlement completes or returns
  an explicit uncertain result.
- **Concurrent check.** A second owner cannot overlap the first. Existing lock, pending, or unknown
  generation state fails closed.

- **Cleanup failure.** Disposable staging and orphan cleanup cannot replace a primary failure. A
  durable artifact blocks a later operation until explicit remediation.

### Interface contracts

Public commands are:

```text
flow packages repository init <canonical-public-https-base> --trusted-root <local-root.json>
flow packages repository status
flow packages repository check
flow packages repository candidates list
flow packages repository candidate inspect <sha256:digest>
flow packages repository candidate remove <sha256:digest>
flow packages repository candidate activate <sha256:digest> --certificate-issuer <issuer> --certificate-identity <identity>
```

Initialization reads one local no-follow regular root file. It validates the root with the standard
client before publication and performs no network request.

A check returns either `already_current` or one committed repository generation plus zero or more
inert candidates. It never returns partially verified metadata or target bytes.

Activation takes the exact candidate digest and a newly supplied exact publisher policy. It
reopens the current generation and candidate, rechecks freshness and identity offline, repeats
Sigstore verification, and delegates the only package mutation to the existing store.

The optional scheduler can request `check` only. It has one owner, one bounded interval, no overlap,
no catch-up burst, and no activation API. It reports fixed `scheduler_started`, `checked`,
`check_failed`, and `clock_rollback` outcomes. A supplied prior completion time makes restart gaps
observable. `missedIntervals` reports elapsed opportunities without replaying them, and
`consecutiveFailures` makes a prolonged outage visible.

## Functional flows

### Initialize

```text
operator base URL + local trusted root
  -> strict URL and local no-follow admission
  -> tuf-js trusted-root self-verification in disposable staging
  -> Flow reopen, bound, digest, and translate
  -> atomic initial generation publication
  -> no network and no package candidate
```

### Explicit or scheduled check

```text
current Flow generation + fixed refresh-start instant
  -> acquire one repository lock and reconcile pending state
  -> copy exact trusted metadata into disposable staging
  -> tuf-js refresh through Flow strict fetcher
  -> threshold root updates, timestamp, snapshot, and targets verification
  -> resolve and download fixed index target
  -> enforce the four-candidate selection bound before package downloads
  -> resolve each selected package target through bounded delegations
  -> reopen and verify all staged metadata and target bytes
  -> parse bundle and repeat offline Sigstore publisher verification
  -> cross-bind repository, package, publisher, and candidate identity
  -> publish one immutable generation record atomically
  -> settle lock, staging, and bounded old-generation cleanup
```

### Reviewed candidate activation

```text
exact candidate digest + newly supplied publisher policy
  -> acquire package mutation ownership
  -> reopen current repository generation and candidate
  -> revalidate exact TUF target identity and current freshness offline
  -> reverify exact capability bundle and Sigstore evidence
  -> reconstruct and compare complete candidate identity
  -> call existing capability package store with exact source and publisher proof
  -> publish or reuse one content-addressed installed package
  -> leave repository candidate present for audit
```

### Durable execution and recovery

```text
admitted workflow package snapshot
  -> durable run, child, detached worker, recovery, and replay
  -> no repository state, candidate state, network, or current-package lookup
```

## Trust and coupling map

| Boundary | Input | Owner after validation | Forbidden coupling |
| --- | --- | --- | --- |
| Trusted root | Explicit local bytes | Flow repository store | Network trust bootstrap |
| Repository transport | Public HTTPS response | Disposable staging only | Ambient credentials or redirects |
| TUF metadata | Standard role bytes | tuf-js for computation, Flow after reopen | tuf-js cache as durable authority |
| Package target | TUF descriptor and envelope | Inert candidate generation | Active package mutation |
| Publisher proof | Sigstore bundle and exact policy | Existing offline verifier | Repository signature substitution |
| Install decision | Active metadata plus exact package evidence | Existing package store | Candidate-controlled policy |
| Runtime package | Immutable admitted snapshot | Durable run | Live repository or candidate lookup |

## Verification map

| Criterion | Class | Planned command | Required proof | Out of scope |
| --- | --- | --- | --- | --- |
| Root initialization and rotation | Standard/interoperability | `npx vitest run test/unit/infrastructure/tuf/staged-tuf-repository.test.ts test/integration/tuf/tuf-conformance-fixture.test.ts` | Explicit root, dual-threshold sequential rotation, expiry, rollback, skip, and unchanged-state failures | Online root bootstrap |
| Snapshot, timestamp, and consistency | Standard/security | Same TUF selector | Freeze, mix-and-match, metadata rollback, hash/length, and consistent target path checks | Alternate mirrors |
| Delegations and bounds | Standard/security | Same TUF selector | Path scoping, terminating order, threshold, encoded role replay, duplicate-name ambiguity, cycle, depth, role, byte, and entry limits | Succinct roles unless independently required |
| Strict public transport | Network/security | `npx vitest run test/unit/infrastructure/http/strict-capability-repository-fetcher.test.ts` | URL, DNS, redirect, status, byte, deadline, cancellation, close, no credential, and privacy matrix | Private repositories |
| Target and package verification | Domain/application | `npx vitest run test/unit/capability/signed-capability-bundle-envelope.test.ts test/unit/application/check-capability-repository.test.ts` | Exact index/custom/envelope/package/publisher cross-binding, pre-download capacity, clock bracketing, and negative mutations | Repository-only publisher trust |
| Atomic durable state | Storage/recovery | `npx vitest run test/unit/infrastructure/fs/local-capability-repository-store.test.ts` | No-follow, exact bounds, lock, pre/post rename, settlement, capacity, concurrency, and remediation | Automatic stale-lock reclamation |
| Reviewed activation | Application/integration | `npx vitest run test/unit/application/activate-capability-repository-candidate.test.ts test/integration/cli/capability-repository.test.ts` | Reopen, freshness, exact policy, active metadata, no check-time mutation, and offline activation | Automatic activation |
| Runtime isolation | Data/recovery | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts` | Attached, child, detached, recovery, and replay use frozen packages while a repository-state trap is present | Live update lookup |
| Optional scheduler | Runtime/concurrency | `npx vitest run test/unit/application/capability-repository-scheduler.test.ts` | No overlap, no catch-up burst, restart/clock/outage visibility, and no activation surface | Daemon-owned activation |
| Public CLI and privacy | CLI/privacy | `npx vitest run test/integration/cli/capability-repository.test.ts` | Exact grammar, fixed output, no bytes, URLs, roots, paths, credentials, response text, or causes | Interactive UI |
| Dependency boundary | Architecture | `npx vitest run test/integration/package/dependency-boundaries.test.ts` | tuf-js imports stay in infrastructure adapter; domain/application use Flow ports | Third-party durable types |
| Release gates | Repository | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Tests, runtime, coverage, build, package, and production audit pass | Hosted environment state |
| Hosted Linux x64 | Hosted | Run the repository CI workflow for the final PR head | Required quality and dependency checks pass on the configured runner | Local platform equivalence |

## Implementation order

### Foundation

1. Added RED domain tests for the index, target custom metadata, envelope, and candidate identity.
2. Added RED application tests for initialization, refresh, check, and activation ports.
3. Pinned tuf-js 6.0.0 and added its license notice.
4. Implemented disposable staging and the strict per-operation fetcher.

### Settlement

1. Implemented the immutable local generation and candidate store.
2. Added CLI commands and the bounded scheduler request surface.
3. Added independent TUF fixtures, runtime isolation regressions, docs, and complete gates.

## Final evidence

The exact Issue #107 selector passed 247 tests in 18 files. It covers the domain, application,
transport, staging, durable store, activation, scheduler, CLI, independent TUF fixture, runtime
isolation, and dependency boundary. The command was:

```text
npx vitest run \
  test/unit/capability/capability-metadata.test.ts \
  test/unit/capability/capability-repository.test.ts \
  test/unit/capability/signed-capability-bundle-envelope.test.ts \
  test/unit/application/capability-repository-candidate.test.ts \
  test/unit/application/check-capability-repository.test.ts \
  test/unit/application/activate-capability-repository-candidate.test.ts \
  test/unit/application/capability-repository-scheduler.test.ts \
  test/unit/infrastructure/http/strict-capability-repository-fetcher.test.ts \
  test/unit/infrastructure/fs/local-capability-package-store.test.ts \
  test/unit/infrastructure/fs/local-capability-repository-store.test.ts \
  test/unit/infrastructure/tuf/staged-tuf-repository.test.ts \
  test/unit/infrastructure/tuf/capability-repository-generation-authenticator.test.ts \
  test/unit/infrastructure/tuf/local-capability-repository-initializer.test.ts \
  test/unit/infrastructure/tuf/local-capability-repository-refresher.test.ts \
  test/integration/cli/capability-repository.test.ts \
  test/integration/tuf/tuf-conformance-fixture.test.ts \
  test/integration/cli/remote-capability-workflow.test.ts \
  test/integration/package/dependency-boundaries.test.ts
```

The independent fixture comes from `theupdateframework/tuf-conformance` revision
`672d7c00051efc97b3a9fa6f4ffa0aeb6647af03`. Flow processes its real ECDSA signatures,
terminating delegation, and consistent-snapshot target path through the production adapter.

`npm run check` passed. Its test gate reported 3,907 passed tests and four skipped tests across
280 passed files and one skipped file. Its runtime gate reported 40 passed tests and 34 skipped
tests across eight passed files and ten skipped files. The command also passed formatting, lint,
type checking, build, and runtime verification. Lint reported one existing informational item
outside this change.

`npm run test:coverage` passed with these repository-wide results:

- Statements: 84.11% (26,282 of 31,246).
- Branches: 78.26% (17,835 of 22,788).
- Functions: 90.57% (4,890 of 5,399).
- Lines: 84.22% (25,776 of 30,603).

`npm run pack:check` installed the generated tarball in a clean consumer and exercised its CLI.
The installed package reported policy digest
`5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.
`npm audit --omit=dev --audit-level=low --json` reported zero production vulnerabilities at all
severity levels. `npm run docs:ste` and `git diff --check` also passed.

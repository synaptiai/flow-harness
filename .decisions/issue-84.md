# Decision Journal: Issue #84 — Reject stale, revoked, or rolled-back capability packages

**Issue**: #84

**Branch**: `codex/issue-84-metadata-freshness`

**Started**: 2026-08-14

---

## Status

Specification, architecture, implementation, focused verification, and adversarial review are in
progress on a clean branch from the merged Issue #83 base. Hosted Linux x64 CI remains pending.

## Specification

_Captured by the specification-capture skill on 2026-08-14. Source: extracted from Issue #84 and
the user-approved delivery-roadmap objective._

### Non-goals

- Do not discover, download, install, activate, remove, or roll back a package automatically.

- Do not add background refresh, mutable tags, package search, or version solving.

- Do not contact metadata, registry, publisher, or signature services during admission, execution,
  inspection, detached work, child work, recovery, or replay.

- Do not let metadata introduce executable package code, hooks, credentials, network authority, or
  wider policy.

- Do not retroactively change or terminate an already admitted immutable run.

- Do not claim freshness when the operator cannot trust the local clock or authenticated metadata
  authority.

- Do not replace the shipped offline Sigstore trust root or add verifier-owned network clients.

### Failure modes

- **Timeouts and cancellation** — Metadata signature verification is local. The operator signal is
  checked before validation and immediately before durable mutation. Cancellation before the
  commit boundary publishes nothing. Once the atomic replacement begins, Flow completes or reports
  commit uncertainty instead of claiming that cancellation rolled it back.

- **Partial failures** — Validation, signature, expiry, target, or monotonic-version failure leaves
  the prior trusted state unchanged. A temporary-file or pre-rename failure also leaves it
  unchanged. A post-rename durability failure reports commit uncertainty and requires inspection.

- **Invalid input** — Empty or oversized input, invalid UTF-8, duplicate keys, or non-canonical
  encoding rejects. Unsorted targets, malformed time, unsafe sources, invalid publishers, and
  inconsistent targets also reject with fixed public stages. A valid empty target list is an
  authenticated deny-all state.

- **Missing context** — A project without trusted metadata retains the existing explicit exact-
  digest package behavior. After the operator establishes trusted metadata, a missing target or
  missing trusted clock context rejects new installation and admission.

- **Dependency outage** — none. Refresh consumes explicit local metadata and Sigstore bundle files.
  It does not own a network client.

- **Resource exhaustion** — Metadata bytes, target count, target strings, parser depth, parser
  nodes, stored state, and file reads have fixed limits. Concurrent mutations fail under the
  existing bounded package mutation-lock policy.

### Interface contracts

- The public refresh shape is `flow packages metadata refresh <metadata.json> --sigstore-bundle
  <bundle.json> --certificate-issuer <https-url> --certificate-identity <exact>`. Inspection is
  `flow packages metadata inspect`.

- The signed artifact uses strict canonical JSON. It declares one positive integer metadata
  version, one canonical UTC expiry, and a strictly sorted unique target list. The list may be
  empty. Once authenticated and stored, that state denies every new installation and admission.

- Each target binds name, exact semantic version, SHA-256 digest, positive byte count, source,
  status, and optional OCI publisher policy. The source is canonical HTTPS or digest-only OCI.
  Status is `active` or `revoked`.

- The existing offline Sigstore verifier authenticates the exact metadata bytes under the explicit
  issuer and identity. Trusted state records the metadata digest, authority policy, signature-
  bundle digest, version, expiry, and canonical targets.

- Lower trusted versions reject. Equal versions are idempotent only when metadata bytes and
  authority policy match exactly. Different bytes at an equal version reject.

- Trusted metadata is optional until first establishment. When present and current, package
  install and catalog admission require one exact active target. Inspection and removal remain
  available for remediation.

- Refresh and package mutation use one project-local mutation owner. Publication is one atomic
  file replacement followed by directory synchronization.

- A catalog that passed the gate becomes an immutable run snapshot. Later refresh never mutates
  that snapshot. The next catalog admission reads the current trusted metadata again.

## Functional flows

### Operator establishes or refreshes authority

```text
explicit metadata file + explicit Sigstore bundle + exact publisher policy
  -> bounded strict metadata parsing
  -> expiry check against the admitted local clock
  -> offline signature verification over exact metadata bytes
  -> acquire package mutation ownership
  -> compare current authority and monotonic metadata version
  -> atomic trusted-state publication
  -> fixed public summary
```

### Operator installs a package

```text
exact HTTPS digest or exact signed OCI artifact
  -> existing artifact and publisher verification
  -> acquire package mutation ownership
  -> read current trusted metadata when present
  -> require exact active target and unexpired state
  -> publish content-addressed blob and package lock
```

### System admits a new run

```text
read and rehash installed package lock and blobs
  -> read current trusted metadata when present
  -> require every selected bundle to match one active target
  -> freeze capability catalog and durable run snapshot
  -> execute and recover from snapshot without later metadata reads
```

### Operator remediates stale or revoked state

```text
inspect trusted metadata and package lock
  -> remove an installed exact version even if metadata is expired or revoked
  -> explicitly refresh metadata or install a permitted replacement
  -> verify before new admissions resume
```

There is no automatic system refresh flow.

## Approaches considered

| Approach | Strength | Weakness | Disposition |
| --- | --- | --- | --- |
| Enable automatic Sigstore TUF refresh | Standard public-good trust refresh and online freshness | Adds hidden network timing, cache state, and automatic trust mutation to an offline verifier | Rejected for this slice |
| Store only the greatest package version seen | Small local rollback fence | Does not authenticate expiry, revocation, source, publisher, or target mapping | Rejected |
| Import one authenticated project metadata snapshot explicitly | Adds expiry, revocation, target binding, and monotonic rollback refusal while preserving operator and network control | Requires a new strict metadata ABI and durable project state | **Selected** |
| Put freshness fields inside every capability bundle | Co-locates content and expiry | An old signed bundle can repeat its old self-asserted freshness and cannot revoke itself safely | Rejected |

## Challenged assumptions

### “A publisher signature proves the newest valid version”

Rejected. A valid historic signature authenticates historic bytes. It does not prove current
authorization, non-revocation, or monotonic version state.

### “Revocation should delete installed bytes immediately”

Rejected. Deletion would mutate operator state and could break durable inspection or recovery.
Revocation blocks new admission. Explicit removal remains an operator action.

### “Every package operation should require metadata from day one”

Rejected for compatibility. Exact digest and publisher evidence remain meaningful without a
freshness layer. The stricter gate becomes project authority only after explicit establishment.

### “Cancellation can always restore the previous file”

Rejected. Cancellation before rename can publish nothing. Cancellation or failure after rename
cannot prove rollback without another consequential mutation. Flow completes settlement or reports
commit uncertainty.

## Coupling analysis

- Domain parsing owns metadata shape, canonical target order, source/publisher consistency, and
  time format. It imports no filesystem, CLI, or network code.

- The application importer owns exact-byte publisher verification and converts verified metadata
  into trusted-state input.

- The package store owns one mutation lock, monotonic comparison, atomic publication, and the
  install/admission gate. It does not verify signatures or fetch data.

- The CLI owns explicit local file selection, command shape, system-clock composition, and public
  summaries. It does not parse metadata ad hoc.

- Existing catalog snapshots remain the run boundary. Workflow, worker, child, recovery, and replay
  modules gain no metadata or network dependency.

- Dependency direction remains acyclic. The CLI imports application, domain, and infrastructure
  code. The application imports domain types and application-owned ports. Infrastructure imports
  domain code and implements those application ports.

## Decision

Implement a strict signed `CapabilityMetadata` artifact and one atomically stored project
`CapabilityMetadataState`. Reuse the existing offline Sigstore verifier for exact metadata bytes.
Share the package mutation lock so refresh cannot race install or remove.

Treat metadata as opt-in project authority. When no state exists, preserve existing exact package
behavior. Once state exists, enforce expiry and exact active-target equality during installation
and catalog verification. Keep list, inspect, and remove available when the state is stale.

## Planned RED -> GREEN -> REFACTOR sequence

1. **Metadata contract** — RED strict canonical parsing, bounds, expiry boundary, target order,
   source/publisher consistency, active/revoked status, and immutable output. GREEN one domain
   parser and canonical serializer.

2. **Trusted-state mutation** — RED first establishment, higher version, equal idempotence, lower
   rollback, equal-version substitution, cancellation, concurrency, atomic failure, and recovery.
   GREEN shared-lock state publication.

3. **Install and admission gates** — RED exact active target success plus absent, revoked, expired,
   digest, byte, source, and publisher mismatches. GREEN one shared target assertion used inside
   store install and verify.

4. **Signed import and CLI** — RED exact metadata signature, command bounds, summaries, fixed
   failures, and credential/private-body suppression. GREEN explicit local refresh and inspect.

5. **Snapshot and offline regression** — RED an already captured catalog surviving later refresh,
   while new catalog admission rejects. Prove no later network or metadata refresh call.

6. **Documentation and release evidence** — Update public trust, clock, recovery, roadmap, security,
   and test contracts. Run focused, full, runtime, coverage, package, prose, dependency, graph, and
   hosted gates.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict authenticated metadata contract | Contract/error | `npx vitest run test/unit/capability/capability-metadata.test.ts test/unit/capability/sigstore-capability-verifier.test.ts test/unit/application/import-capability-metadata.test.ts` | Exact canonical metadata and signature pass; all bounds, shape, expiry, authority, and target mutations reject with fixed stages | Automatic trust-root refresh |
| Monotonic atomic trusted state | Data/recovery | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts --maxWorkers=1` | First/higher/equal-identical refreshes settle; lower/equal-different, pre-rename cancellation/failure, concurrent refresh, and post-rename uncertainty preserve or report exact state | Multi-host writers |
| Install and admission enforcement | Behavioral/security | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts test/unit/capability/installed-capability-catalog.test.ts --maxWorkers=1` | Active targets pass; absent, revoked, expired, and every identity or publisher leaf mismatch reject before new admission | Retroactive run termination |
| Explicit CLI and privacy | Integration/error | `npx vitest run test/integration/cli/capability-packages.test.ts -t 'metadata|keeps exact installed-package inspection' --maxWorkers=1` | Refresh and inspect are explicit; output/state omit private bundle bytes and nested causes; malformed input changes no state; remediation inspection survives expiry and revocation | Background refresh |
| Immutable offline snapshots | Integration/recovery | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts --maxWorkers=1` | Revocation during an attached run blocks new admission but not its verifier/child; the durable snapshot drives detached work, inspection, and terminal recovery with metadata and network traps | Availability of deleted local bytes |
| Application port direction | Architecture | `npx vitest run test/integration/package/dependency-boundaries.test.ts` | Application modules import domain contracts and application-owned ports but no infrastructure implementation | Runtime call-graph equivalence |
| Public documentation | Docs | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts test/integration/package/docs-ste.test.ts` | Clock trust, expiry, revocation, rollback, recovery, explicit control, and offline limits match behavior | General package safety |
| Local release quality | Release/runtime | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm ls --all` | Static, full, coverage, runtime, package, documentation, and dependency-graph gates pass | Vulnerability-registry availability or hosted-runner behavior |
| Hosted Linux x64 | Hosted | Run `.github/workflows/ci.yml` for the published stacked draft PR and inspect its required checks | The configured Linux x64 jobs pass from the repository event and runner environment | Local Docker equivalence or external authority uptime |

Every Issue #84 criterion maps to at least one row. Final evidence must identify local-clock trust,
synthetic signatures, platform skips, untested metadata ecosystems, and negative cases.

## Implementation and local verification evidence

The local implementation adds strict canonical capability metadata and exact offline Sigstore
import. It adds monotonic atomic state, install and catalog gates, explicit CLI commands, and
immutable admitted snapshots. An authenticated empty target set is a deliberate deny-all state.
Metadata never triggers a package or run mutation by itself.

Final focused evidence on the clean merged base includes 160 passing tests across the seven
non-socket mapped files and one passing durable snapshot test with local Unix-socket permission
(161 tests across eight files in total). The full suite passes 3,256 tests with four intentional
platform skips. Runtime verification passes 39 tests with 33 platform or configuration skips.
Coverage passes at 82.95% statements, 77% branches, 89.41% functions, and 83.07% lines.

Formatting, linting, type checking, compilation, compiled smoke, changed-document prose, clean
package installation, and `npm ls --all` pass. The authorized runtime audit reports zero
vulnerabilities. The Prime dependency audit passes its Node lock and 60 Python packages. Three
independent review facets report zero P1, P2, or P3 findings.

Hosted Linux x64 CI remains the final environment-owned acceptance signal. A local Docker run is
not equivalent to the configured hosted workflow. It does not reproduce runner services,
permissions, workflow composition, or repository event state.

## Primary references

- The Update Framework specification: <https://theupdateframework.github.io/specification/latest/>

- Sigstore trust-root format: <https://github.com/sigstore/protobuf-specs>

- Sigstore bundle format: <https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto>

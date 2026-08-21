# Decision journal: Issue #143 — Add bounded environment diagnostics for the public preview

**Issue:** #143 | **Branch:** `codex/issue-143-flow-doctor` | **Started:** 2026-08-21

## Context

Gate 8.1 publishes one installable preview, but a user must currently infer host readiness from
separate launcher, configuration, sandbox, provider, Docker, and Prime failures. Gate 8.2 adds one
read-only diagnostic surface without making an optional execution path a universal requirement.

## Research

- Node exposes the current platform, architecture, executable, and runtime version through stable
  process APIs. The package launcher already owns the minimum operating-system and Node.js
  contract. Diagnostics reuse that contract instead of copying it.

- Sandbox Runtime exposes structured dependency errors and warnings. Its native Flow composition
  also applies stricter executable, filesystem, namespace, and cleanup checks. A useful diagnostic
  must exercise the Flow-owned composition boundary, not report only whether a binary exists.

- npm's doctor command groups environment checks and treats project read/write access as an
  explicit requirement. Flow adopts the grouped, actionable result pattern, but not npm's default
  network checks: a credential-free Flow path must remain offline.

- Docker documents `/_ping`, version, and information endpoints as read-only Engine API surfaces.
  Flow's Prime attestation checks the socket, daemon, image, executables, cgroup, host policy, and
  API identity. It does not create a container. Diagnostics reuse this currentness proof.

- The pinned Pi model runtime can restore its local catalog and credential status with model
  network refresh disabled. Provider diagnostics therefore do not need to resolve, print, or test
  a credential against a remote provider.

Primary sources:

- [Node.js process API](https://nodejs.org/api/process.html)
- [npm doctor](https://docs.npmjs.com/cli/npm-doctor/)
- [Docker Engine API](https://docs.docker.com/reference/api/engine/)
- [Docker Engine ping](https://docs.docker.com/reference/api/engine/version-history/#v140-api-changes)
- [Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)

## Approaches

| Approach | Summary | Main advantage | Main risk |
| --- | --- | --- | --- |
| Static checklist | Inspect versions, files, and executable discovery only. | Fast and strictly observational. | Can claim readiness even when Flow's composed sandbox or attestation rejects. |
| Run every dependency | Probe providers, Docker, Prime, and every sandbox on each invocation. | Broad inventory. | Makes optional systems appear mandatory and can cause network or runtime side effects. |
| Selected-path composition | Check the base project, then only the configured or explicitly selected optional path through existing Flow boundaries. | Matches actual authority and preserves credential-free use. | Requires explicit skip semantics and dependency ordering. |

## Decision

Use selected-path composition. `flow doctor` checks the host, project, configuration, filesystem,
and configured sandbox. An optional workflow argument adds workflow host requirements,
model-catalog, and local credential checks. `--profile prime-agent` selects the fixed Prime
currentness path. A workflow and
the Prime profile cannot be selected together because they diagnose different entry points.

The command returns one deterministic JSON report. It uses a fixed check order, the statuses
`pass`, `fail`, and `skip`, stable category identifiers, fixed value-free messages, and fixed
remediation. A failed blocking check returns exit status 1. Invalid command grammar returns the
existing usage status 2. Caller cancellation remains exact inside the application boundary and is
converted to one fixed public CLI message.

## Specification

_Captured on 2026-08-21. Source: the approved roadmap, Issue #143, repository contracts, and primary
source research._

### Non-goals

- Diagnostics do not contact a model provider or validate a credential remotely. They do not
  prepare Prime, create a container, start a supervisor, execute a workflow, or mutate project
  state.

- Diagnostics do not make Docker, Prime, a provider, or an unselected sandbox a prerequisite for
  credential-free use.

- Diagnostics do not promise that a requirement remains current after the report. Authoritative
  run admission repeats every required check.

- Diagnostics do not print paths, credential metadata, provider responses, Docker responses,
  nested causes, or model-generated remediation.

### Failure modes

- **Timeouts** — Each probe has a fixed deadline, and the fixed check count bounds the complete
  operation. A probe timeout becomes its stable failure category. A caller cancellation retains
  precedence over a timeout.

- **Partial failures** — Independent later probes continue when their prerequisites are available.
  A dependent probe is `skip` when an earlier prerequisite failed. No result is inferred from a
  failed prerequisite.

- **Invalid input** — Unknown, repeated, or incompatible arguments fail with the existing bounded
  usage surface before configuration or host inspection.

- **Missing context** — A missing project, workflow, local credential, Docker daemon, or Prime
  attestation produces the relevant fixed failure and remediation. Missing optional context is not
  inspected unless its path was selected.

- **Resource exhaustion** — The check count, provider/model requirement count, output bytes, probe
  duration, and total duration are fixed and bounded. Raw external output never enters the report.

### Interface contracts

- The public grammar is `flow doctor [<workflow.yaml|workflow:name@version|activation:id>]
  [--profile prime-agent]`. The optional workflow and explicit Prime profile are mutually
  exclusive.

- Report version 1 contains `ok`, `target`, and an ordered `checks` array. Every check contains only
  `category`, `status`, `message`, and an optional `remediation`. No private diagnostic field or
  cause is serializable.

- The package launcher recognizes valid `doctor` grammar before loading the full CLI. On an
  unsupported host, it returns the same version 1 host-failure report. Other commands retain the
  existing fixed launcher error because they cannot safely load the CLI on that host.

- Stable categories are owned by the application layer. Infrastructure adapters return only
  success or throw. They cannot construct public text.

- Workflow admission reuses the same immutable package, policy, and compilation checks as
  `validate` and `run`. Flow checks recursively selected Linux-only agent commands before provider
  inspection. Provider inspection uses the exact admitted workflow.

- The configured native sandbox probe can create only bounded temporary host resources and must
  settle them before reporting. The container and Prime probes are observational and reuse the
  prepared attestation currentness check.

- Every execution command repeats authoritative admission. A passing diagnostic never grants run,
  package, provider, sandbox, Docker, or continuation authority.

## Acceptance verification map

| Criterion | Evidence command | Expected result |
| --- | --- | --- |
| Host, project, configuration, and filesystem checks are read-only and stable. | `npx vitest run test/unit/application/environment-doctor.test.ts test/integration/cli/doctor.test.ts` | Pass, failure, skip, ordering, cancellation, privacy, and unchanged-tree cases pass. |
| Only the configured sandbox is checked. | `npx vitest run test/integration/cli/doctor.test.ts test/unit/infrastructure/runtime/production-environment-doctor.test.ts` | Native and container selection use separate bounded probes; unselected probes are never called. |
| Workflow selection checks exact admission, host requirements, models, and local credentials offline. | `npx vitest run test/integration/cli/doctor.test.ts test/unit/application/environment-doctor.test.ts test/unit/infrastructure/pi/pi-environment-doctor.test.ts` | Credential-free, Linux-only agent command, missing model, missing credential, packaged verifier, child, and no-network cases pass. |
| Prime selection is observational and value-free. | `npx vitest run test/integration/cli/doctor.test.ts test/unit/infrastructure/oci/prime-environment-doctor.test.ts` | Platform, missing preparation, currentness, timeout, and private-cause cases pass without lifecycle calls. |
| Installed Linux and macOS packages expose diagnostics. | `npm run pack:check && npx vitest run test/scaffold/preview-release-workflow.test.ts` | The clean install runs `flow doctor` after initialization on each supported release host. |
| Public documentation is segmented and current. | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts test/scaffold/community-files.test.ts` | The diagnostics guide owns the task and report contract, linked pages own related setup or remediation, README stays concise, and status, roadmap, and architecture agree. |
| The complete repository remains releasable. | `npm run check && npm run test:coverage && npm run test:browser && node scripts/smoke-compiled.mjs && npm run pack:check && node scripts/audit-prime-dependencies.mjs && npm audit --omit=dev --audit-level=low` | Static, runtime, coverage, browser, compiled, packed, dependency, and audit gates pass. |

## Implementation evidence

_Recorded on 2026-08-21 from the settled Issue #143 tree._

- The exact 10-file acceptance selector passed 90 tests:

  ```text
  npx vitest run test/unit/application/environment-doctor.test.ts test/integration/cli/doctor.test.ts test/unit/cli/launcher.test.ts test/unit/infrastructure/pi/pi-environment-doctor.test.ts test/unit/infrastructure/runtime/production-environment-doctor.test.ts test/unit/infrastructure/oci/prime-environment-doctor.test.ts test/scaffold/package.test.ts test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts test/scaffold/community-files.test.ts
  ```

- The complete serial selector passed 4,653 tests and skipped the four platform-dependent tests:

  ```text
  npx vitest run --no-file-parallelism --maxWorkers=1
  ```

- Coverage passed the same 4,653 tests. It reached 84.78% statements, 79.41% branches, 91.40%
  functions, and 84.93% lines.

- Browser tests passed 2 tests. Runtime verification passed 43 tests and skipped 34 platform-gated
  tests.

- The compiled smoke test and build passed. Documentation and packed-install checks passed. Prime
  and production dependency audits passed.

- The packed-install verification installed the tarball in a clean project. It initialized the
  project and ran the installed `flow doctor`. The complete initialized project tree was unchanged
  afterward.

- A real local `flow doctor` project check passed outside the desktop socket sandbox. The same
  check failed only its native-sandbox probe inside that sandbox because the desktop sandbox
  denied its temporary Unix socket.

- One exact parallel `npm run check` attempt passed formatting, lint, and type checking. During its
  test phase, the pre-existing Prime image inventory boundary test timed out after 30 seconds. This
  occurred under full-suite contention. That exact test passed independently in 6.62 seconds. The
  complete serial suite also passed it. No Issue #143 failure was present.

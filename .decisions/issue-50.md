# Decision Journal: Issue #50 — Run reusable versioned local verifier packages

**Issue**: #50 | **Branch**: `codex/issue-50-verifier-packages` | **Started**: 2026-08-08
**Base dependency**: PR #49, commit `f6b293e4f668834bd2a30965eebb8461e23d7b06`

---

## Context and mapped flows

Flow already has two complementary seams: a strict verifier node whose command/model drivers emit
one typed verdict, and a capability snapshot that freezes local Agent Skills across attached,
detached, child, and recovery execution. Issue #40 explicitly deferred external verifier packages
to Gate 6, and Issue #48 supplied the immutable provider-neutral transport needed to carry them.

### User: author and select a deterministic package

1. The user authors a versioned project-local verifier manifest and validates its metadata without
   executing it.
2. A workflow selects the exact package name/version.
3. Flow snapshots the selected manifest, binds its deterministic command definition, and executes
   it through the existing command verifier and sandbox.
4. The durable verdict records the selected package identity and digest.

### User: author and select a provider-neutral model package

1. The package contributes a reusable bounded rubric, but no model credentials, provider SDK type,
   evidence source, tool, or graph authority.
2. The workflow selects the package and separately declares ordered evidence, exact model, thinking
   level, and timeout.
3. Flow binds the immutable rubric and invokes the existing zero-tool model verifier.
4. Replay proves which rubric package produced the verdict without contacting the model provider.

### Operator: inspect trust before admission

1. The operator lists discovered package metadata and provenance without executing the package.
2. Inspection validates and reports exact version/digest/file identity without printing the rubric.
3. Validation fails the whole requested set if any selected package is missing, malformed, unsafe,
   or changes during snapshotting.

### System: detached, child, and recovery execution

1. Admission persists one bounded capability snapshot containing every selected skill and verifier
   package required anywhere in the workflow tree.
2. Detached jobs and child runs transport that exact snapshot; unexpected but parent-owned entries
   remain allowed only for child execution.
3. Recovery obtains the snapshot from the durable `run_started` event and refuses a supplied or
   drifted replacement.
4. The scheduler resolves each package reference from the snapshot immediately before invocation
   and validates returned package-use evidence before publishing the outcome.

## Research and challenged assumptions

- Pi packages are convenient bundles, but Pi extensions execute in-process with full system
  permissions. Reusing its extension loader would erase Flow's policy and replay boundary. See
  <https://pi.dev/docs/latest/packages> and <https://pi.dev/docs/latest/extensions>.
- OMP custom tools are executable modules, while OMP skills are inert instructions. Its approval
  guide also treats unknown custom tools conservatively. This supports keeping evaluator manifests
  declarative until Flow has a separate plugin process and dynamic approval. See
  <https://github.com/can1357/oh-my-pi/blob/main/docs/custom-tools.md>,
  <https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md>, and
  <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md>.
- Prime Verifiers is a mature Python/RL evaluator ecosystem, but direct import would couple the
  harness core to its environment and reward runtime. The existing Flow-owned verifier port is the
  narrower interoperability seam. See <https://github.com/PrimeIntellect-ai/verifiers>.
- Prime Agent separates presentation, supervisor, worker, session, and kernel lifecycles and warns
  that lifecycle separation alone is not a security boundary. Package execution therefore stays
  inside the already-governed verifier drivers. See
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>.
- A manifest-only framework with no package-backed execution would satisfy a roadmap noun but not a
  user outcome. This slice must run both existing verifier kinds end to end.

## Specification

_Captured by specification-capture on 2026-08-08. Source: extracted from Issue #50._

### Non-goals

- Does not install from registries, Git repositories, URLs, or other network sources.
- Does not execute bundled JavaScript, TypeScript, Python, shell, hooks, or package lifecycle code.
- Does not add tools, dynamic tool approval, execute/network model tools, policy/workflow/UI
  packages, a general plugin host, or Prime Verifiers as a dependency.
- Does not add failure/fallback edges, inconclusive retries, or rejection-as-success semantics.
- Does not claim model packages are deterministic or prompt-injection-proof.
- Does not remove inline verifier definitions or invalidate historical inline-verifier ledgers.

### Failure modes

- **Timeouts** — The existing driver timeout becomes a typed inconclusive verdict. Flow never
  changes package, driver, command, model, or rubric implicitly.
- **Partial failures** — Discovery or snapshot failure rejects the complete requested package set;
  no partial snapshot or run is admitted.
- **Invalid input** — Unknown fields, malformed versions, duplicate identities, kind/selection
  mismatch, unsafe entries, excessive sizes, and digest/manifest inconsistencies fail with bounded
  typed errors before executor invocation.
- **Missing context** — A missing project root, package root, selected package, exact version, or
  durable snapshot fails closed. An empty unused catalog remains valid.
- **Dependency outage** — Model/provider or command-runtime failure retains existing inconclusive
  semantics and durable bounded evidence; package discovery has no network dependency.
- **Resource exhaustion** — Per-file/package/snapshot limits fail admission. Existing node-start,
  model-token, reported-cost, and execution-time budgets retain precedence during execution.
- **Source race** — Symlinks, non-regular files, identity replacement, or byte changes between
  discovery and snapshot fail closed rather than capturing mixed generations.
- **Cancellation** — Existing cancellation precedence wins; a package cannot translate cancellation
  into acceptance.

### Interface contracts

Project-local manifest:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: release-tests
  version: 1.0.0
  description: Run the repository release test gate.
  license: Apache-2.0
  compatibility: Requires Node.js and npm.
spec:
  kind: command
  command:
    executable: npm
    args: [test]
    timeoutMs: 120000
```

Provider-neutral model manifest and workflow selection:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Judge whether declared evidence proves the requested behavior.
spec:
  kind: model
  prompt: Decide whether the evidence proves the stated behavior. Reject unsupported claims.
```

```yaml
verifier:
  kind: packaged-model
  package: { name: evidence-review, version: 1.2.0 }
  evidence:
    - { nodeId: tests, field: command.stdout }
  model: { provider: anthropic, id: claude-sonnet-4-5, thinking: medium }
  timeoutMs: 120000
```

Command selection uses `kind: packaged-command` and the same exact package tuple. Inline `command`
and `model` verifier kinds remain unchanged. Manifest identity is `(kind, name, exact version,
digest)`. A model package owns only its rubric; the workflow owns evidence order and provider/model
selection. A command package owns the complete existing argv-only command declaration.

The capability snapshot becomes a bounded union of `agent-skill` and `verifier-package` records,
canonically ordered by kind/name. A verifier-package record preserves API version, package version,
metadata, trust=`project-explicit`, portable provenance, parsed definition, exact manifest bytes and
hash, and a recomputable package digest. Package-use evidence stores name, version, and digest on
the existing typed verifier evidence. Inline verifier evidence omits package identity.

## Coupling analysis

```text
local manifest -> secure catalog -> immutable capability snapshot -> run_started / detached job
                                                               |
workflow package ref -> compiler/control graph -> scheduler binding -> existing verifier executor
                                                               |                |
                                                               +-- package use --+
                                                                      |
                                                   typed verifier evidence -> reducer/replay
```

- Domain capability code owns strict manifest/snapshot identities, canonical digests, bounds, and
  package lookup. It imports no filesystem, executor, provider, or supervisor implementation.
- Infrastructure owns no-follow local discovery and exact-byte snapshot construction.
- Workflow domain owns strict package-reference shapes and direct evidence compatibility but never
  discovers project files.
- Application binds one package reference to one immutable snapshot definition, passes only the
  existing concrete verifier shape to the executor, and validates returned identity.
- The verifier executor retains all command containment and zero-tool model invariants and merely
  stamps the supplied immutable package identity on evidence.
- Run domain independently checks the persisted requirement/snapshot/control-graph/evidence
  relationship, so replay does not trust application claims.
- Supervisor transports the provider-neutral union snapshot unchanged; it never interprets package
  content.

## Approaches considered

| Approach | Simplicity | Flexibility | Safety/portability | Effort | Disposition |
| --- | --- | --- | --- | --- | --- |
| In-process Pi/OMP-style extension host | High author convenience | Very high | Low: arbitrary host code, runtime coupling, weak replay provenance | Medium | Rejected |
| Generic manifest framework without execution | Medium | High in theory | Medium, but no user outcome and premature abstraction | Medium | Rejected |
| Import Prime Verifiers environments directly | Low | High for RL/eval workloads | Low for a TypeScript provider-neutral core; Python/runtime coupling | High | Deferred to a future adapter |
| Strict local declarative verifier packages over existing drivers | High | Medium now, extensible through versioned package kinds | High: inert manifests, exact snapshots, existing sandbox/zero-tool boundaries | Medium | **Selected** |

The most important trade-off is deliberately limiting package expressiveness. Arbitrary evaluator
code would be more flexible, but without an out-of-process capability sandbox it would let a package
bypass the exact authority boundary the standalone harness exists to provide.

## Decision

Implement strict project-local `VerifierPackage` manifests and exact package selections for both
existing verifier drivers. Extend the immutable capability snapshot as a tagged package union rather
than adding a second transport. Keep model selection and evidence in the workflow so model packages
remain provider-neutral. Preserve exact package identity in the control graph, run-start
requirements, execution evidence, detached records, children, and recovery. Maintain inline
verifier compatibility. Defer executable package code and remote installation.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict versioned manifests, discovery, bounds, races | Contract/adversarial | `npx vitest run test/unit/capability/local-verifier-packages.test.ts` | Valid packages snapshot exactly; malformed, duplicate, unsafe, oversized, and changed sources reject | Remote installation or executable resources |
| Exact workflow selection and driver compatibility | Contract | `npx vitest run test/unit/workflow/verifier-package-compiler.test.ts test/unit/capability/workflow-capabilities.test.ts` | Package variants compile, inline variants remain stable, incompatible/missing/version-drift selection rejects | General plugin manifest types |
| Durable requirements, identity, and replay | Domain/adversarial | `npx vitest run test/unit/run/verifier-package-reducer.test.ts` | Snapshot/control-graph/evidence identity mutations reject; old inline evidence remains valid | Cross-version event migrations beyond current v1 |
| Existing driver execution through packaged definitions | Application | `npx vitest run test/unit/application/run-workflow-verifier-packages.test.ts test/unit/application/verifier-executor.test.ts` | Command/model packages resolve once, preserve containment/zero-tool behavior, and stamp exact use evidence | Model correctness or prompt-injection immunity |
| Attached/detached/child/recovery composition | Integration | `npx vitest run test/integration/cli/verifier-packages.test.ts test/integration/supervisor/worker.test.ts -t "verifier package"` | Exact snapshot crosses submission/worker/child/recovery without live rediscovery | Host-reboot and remote-worker execution |
| Metadata operations and public contract | Integration/docs | `npx vitest run test/integration/cli/verifier-packages.test.ts test/scaffold/community-files.test.ts` | List/inspect/validate avoid execution; docs/examples match behavior | TUI or registry UX |
| Complete package regression | Release | `npm run check && npm run test:runtime && npm run pack:check && npm audit --audit-level=high` | Formatting, lint, types, source/runtime tests, build, installed CLI, and dependency audit pass | Hosted CI availability |

## Planned RED -> GREEN -> REFACTOR sequence

1. **Manifest RED/GREEN** — Prove strict parsing, canonical identity/digest, exact-byte snapshots,
   symlink/race refusal, duplicate/version/bound errors, and immutable lookup.
2. **Workflow RED/GREEN** — Add packaged command/model source and compiled shapes, loop remapping,
   source compatibility, digest/control-graph coverage, and capability selection binding.
3. **Run contract RED/GREEN** — Persist exact package requirements, union snapshots, package-use
   evidence, and independent replay consistency while preserving old inline ledgers.
4. **Execution RED/GREEN** — Resolve package definitions from the snapshot, retain evidence binding,
   timeout/cancellation/budget behavior, command containment, and zero-tool model execution.
5. **Composition RED/GREEN** — Add metadata CLI operations plus attached/detached/child/recovery
   integration with no live-source fallback.
6. **REFACTOR/VERIFY** — Remove duplicated scanner/canonicalization logic only where the abstraction
   has two proven consumers, update every public document/example, then run mutation probes,
   adversarial review, coverage, runtime, package, audit, action-lint, and graph refresh.

## Implementation tasks

1. [x] Build and verify the strict local verifier-package catalog and union snapshot.
2. [x] Compile and bind exact packaged command/model verifier selections.
3. [x] Persist and replay package requirements and use evidence.
4. [x] Execute packaged verifiers through the existing safety boundary.
5. [x] Complete CLI, attached/detached/child/recovery integration.
6. [x] Update examples, README, architecture, workflow, security, recovery, testing, capability,
   and roadmap documentation; run full and adversarial verification.

## Verification and adversarial review

The final review first mapped every Issue #50 acceptance criterion to implementation and runnable
evidence, then examined security, correctness, error behavior, performance, maintainability, tests,
and public claims. A separate holdout pass mapped its results only to the visible acceptance
criteria. Two material findings were reproduced with failing tests and fixed before release:

- A valid parent-owned snapshot containing two versions of one verifier name could resolve the
  first name match instead of the exact selected `(name, version)` tuple. Binding, execution
  resolution, run-start reconciliation, and verdict replay now all use the exact tuple.
- A malformed capability snapshot supplied through the application API could reach a permissive
  custom event store before reducer validation. Capability binding now validates, copies, and deeply
  freezes the complete snapshot before persistence or executor invocation. Typed errors also
  distinguish invalid snapshots, unexpected skills, and unexpected verifier packages.

The added tests prove both defects fail before execution, invalid snapshots leave no event behind,
and child execution selects the exact requested version from a parent-owned multi-version snapshot.
After the fixes, the review and holdout passes had no unresolved P1, P2, or P3 findings.

Verification ran from clean commit `c34d9a89d133d226d8934dbef1d482dd54919772` in a tracked-only
copy:

- `npm run check`: format, lint, typecheck, 92 source files / 1,184 tests, build, and 3 runtime files
  / 20 process tests passed.
- `npm run test:coverage`: 83.93% statements, 77.79% branches, 93.58% functions, and 83.96% lines.
- `npm run pack:check`: clean tarball installation and installed CLI execution passed; the installed
  project reported policy digest
  `5818be92618d24b2680a89bfae4a3b6678f7190cc93f06d02de90a797ef52c85`.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `actionlint .github/workflows/ci.yml`: passed.

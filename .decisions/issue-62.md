# Decision Journal: Issue #62 — Run reusable digest-pinned workflow packages

**Issue**: #62 | **Branch**: `codex/issue-62-versioned-workflow-packages` | **Started**: 2026-08-09

---

## Context

Gate 6 already supports three inert capability ABIs: Agent Skills, verifier manifests, and
declarative command-tool manifests. Issue #60 added deterministic `.flowpkg` distribution,
digest-pinned public-HTTPS installation, a content-addressed project store, and offline admission,
execution, and recovery. The remaining workflow-contribution gap is not permission to execute a
plugin. It is the ability to select exact reusable workflow source, pass it through the existing
compiler, and preserve its package identity across every durable boundary.

The repository graph identified the compiler, capability snapshot, child-workflow compiler,
project capability catalogs, detached supervisor protocol, and run-start reducer as the relevant
communities. Direct source inspection confirmed two constraints:

1. child workflows are compiled recursively under shared depth and run-tree limits; and
2. detached workers recompile admitted source, while recovery reconciles a compiled workflow with
   the durable capability snapshot.

Therefore package resolution must happen before execution, must be replayable from admitted bytes,
and must not create a second compiler or scheduler.

## External evidence

- [Pi packages](https://pi.dev/docs/latest/packages) can bundle executable extensions and install
  dependencies, and Pi explicitly warns that packages run with full system access. Flow cannot use
  that authority model for an inert replay-safe package ABI.
- [Pi extensions](https://pi.dev/docs/latest/extensions) can register tools, commands, providers,
  event middleware, and UI and can mutate tool input without revalidation. Those are useful
  interactive hooks but are deliberately outside the Flow package boundary.
- [OMP](https://github.com/can1357/oh-my-pi) obtains much of its value from benchmarked native tools,
  typed subagent results, and a unified filesystem-shaped surface. This supports benchmarking
  high-value native capabilities separately; it does not justify executable workflow packages.
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) keeps continual refinements
  supplemental, reviewable, and rollbackable and does not rewrite the immutable base prompt. That
  supports deferring Gate 7 activation until package identity and evaluation are complete.
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
  demonstrate exact reusable workflow selection and typed results; GitHub recommends immutable SHA
  references for stability and security. Flow goes further by admitting exact bytes into its own
  durable snapshot instead of resolving a remote ref during execution.
- [OCI content descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
  define the useful verify-size-and-digest-before-consumption principle already used by `.flowpkg`.

## Milestone choice

| Candidate | Value | Existing seam | Main risk | Disposition |
| --- | --- | --- | --- | --- |
| Versioned workflow packages | Completes the next compositional Gate 6 ABI and removes copied child source | Compiler, child nodes, bundle store, capability snapshot | Resolution/snapshot chicken-and-egg | **Selected** |
| Policy or UI packages | Closes the same roadmap bullet | Configuration digest; no UI host yet | Policy is authority-bearing and UI has no stable surface | Defer |
| Stronger VM/managed sandbox | Enables hostile workloads and later executable extensions | Existing sandbox port | Platform/deployment scope and unavailable local backends | Separate Gate 3 slice |
| Gate 7 adaptive refinement | Highest product differentiation | Optimization evaluation and candidate-promotion saga | Premature activation before complete package/eval contracts | Defer |
| OMP-inspired native tool adoption | Immediate ergonomics potential | Flow-owned tool broker | Feature-count bias without benchmark evidence | First benchmark, separate issue |

## Architecture alternatives

### A. Flow-owned source manifest plus immutable admission snapshot — selected

A package contains one bounded inert manifest whose payload is ordinary public Flow workflow source.
Local/installed catalogs resolve an exact name and version. The standard compiler receives a closed
resolver over the admitted snapshot, recursively compiles package-selected children under the same
limits, and records package identity in the compiled workflow. Detached workers and recovery use the
snapshot, not the catalog.

- **Strengths**: reuses current validation, graph semantics, digests, budgets, child isolation,
  capability store, and replay rules; provider-neutral; no package code.
- **Costs**: requires two-phase admission so transitive package references are discovered before the
  final immutable compile; snapshot and event size limits must remain explicit.
- **Security**: packages can describe work only within the existing workflow language. They cannot
  alter the compiler, policy broker, sandbox, evaluator implementation, provider configuration, or
  package resolver.

### B. Package serialized compiled graphs — rejected

Publish the private `CompiledWorkflow` representation and execute it directly.

- **Strengths**: fast load and no source resolution at admission.
- **Failure**: serialized internals would become an accidental stable ABI, could bypass validation
  added by future compiler versions, and would couple packages to expansion details for loops,
  optimizations, and control graphs.

### C. Pi/OMP-style executable workflow modules — rejected

Load JavaScript/TypeScript that registers nodes, tools, middleware, or workflow factories.

- **Strengths**: maximal flexibility and familiar extension ergonomics.
- **Failure**: arbitrary host code can mutate runtime behavior before Flow policy, journaling, or
  containment. Provider/runtime coupling would enter persisted behavior and violate Gate 6
  non-escalation.

### D. Parameterized workflow templates — deferred

Add inputs, interpolation, defaults, secrets, outputs, and a template expression language now.

- **Strengths**: convenient reusable automation similar to mature workflow engines.
- **Failure**: substitution introduces a second validation language, secret-flow questions, digest
  ambiguity, and dynamic authority. Exact source reuse is independently useful and is the smaller
  safe primitive.

## Decision

Implement alternative A. Workflow packages are inert source capabilities. The compiler remains the
only authority that can turn source into a graph, the scheduler remains the only transition
authority, and the package snapshot remains the only package source available after admission.

Resolution uses two phases:

1. discover bounded exact package references and compile a preview against race-detecting catalog
   sources to determine the transitive package set;
2. snapshot that exact set, then compile again using only the immutable snapshot.

The second compile is authoritative. If discovery and capture disagree, admission fails. The final
compiled workflow contains the exact package-use identity, so its ordinary workflow digest binds
package provenance without changing digests for existing inline workflows.

## Ownership and coupling

| Concern | Owner | Must not own |
| --- | --- | --- |
| Manifest parsing, identity, package/snapshot digest | Capability domain | Filesystem discovery or graph execution |
| Child reference syntax and recursive compilation | Workflow domain | Filesystem, network, or package installation |
| Local/installed discovery and race-safe capture | Filesystem infrastructure | Workflow transitions or policy |
| Bundle encoding, installation, lock state | Existing package store | Package execution or resolution during a run |
| Root source-locator UX and admission orchestration | CLI composition | Alternate workflow semantics |
| Detached source/snapshot handoff | Supervisor protocol/service/worker | Live catalog fallback |
| Durable package requirements and reconciliation | Run event domain | Package fetching or compiler mutation |
| Child isolation, budgets, typed result, evidence | Existing application runtime | Package-specific exceptions |

Coupling rules remain unchanged:

- no Pi, OMP, Prime Agent, provider, filesystem, or network type enters the workflow/package public
  contract;
- package resolution cannot add a tool, policy action, evaluator, credential, environment value, or
  sandbox permission;
- no package hook runs during discovery, packing, installation, validation, compilation, replay, or
  recovery;
- packages cannot bypass dependencies, joins, limits, approvals, child isolation, evidence, or
  acceptance.

## Specification

_Captured by specification-capture skill on 2026-08-09. Source: extracted-from-issue._

### Non-goals

- Executable package code, hooks, providers, install scripts, dependency installation, arbitrary
  evaluator runtimes, or package-defined policy.
- Policy packages, UI packages, signed registries, automatic updates, dependency solving, or
  compatibility negotiation.
- A general parameter/template language, dynamic graph generation, unbounded recursion, or relaxed
  workflow, child, budget, policy, sandbox, evidence, and replay limits.
- A claim that Flow beats the legacy plugin without the separate held-out product benchmark.

### Failure modes

- **Timeouts** — discovery and snapshotting are bounded local operations with no network. Explicit
  remote bundle installation retains the existing single bounded deadline and digest-before-parse
  rule. Compilation performs no external wait.
- **Partial failures** — a package becomes runnable only after the whole manifest and transitive set
  validate and the final snapshot-only compile succeeds. An interrupted install retains the existing
  inactive-orphan or durable-lock behavior; no partial package enters a run.
- **Invalid input** — malformed YAML, aliases, unknown fields, invalid UTF-8, non-exact versions,
  incompatible result nodes, cycles, excessive depth/size/count, collisions, and mismatched digests
  produce bounded typed diagnostics before the affected graph executes.
- **Missing context** — selecting a package without a Flow project/catalog, required exact version,
  durable snapshot, or matching recovery evidence fails closed. There is no inline, latest-version,
  live-catalog, or network fallback.
- **Source drift** — identity or byte changes between discovery and capture abort admission. After
  admission, live source mutation/removal is irrelevant; missing or inconsistent durable bytes block
  detached execution/recovery rather than causing rediscovery.
- **Namespace ambiguity** — duplicate local identities, local/installed collisions, duplicate bundle
  identities, or ambiguous provider-independent locators fail before selection.

### Interface contracts

Project-local package:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.0.0
  description: Run a bounded release check
  license: Apache-2.0
  compatibility: flow.synapti.ai/v1alpha1
spec:
  workflow: |-
    apiVersion: flow.synapti.ai/v1alpha1
    kind: Workflow
    metadata: { id: release-check }
    # ordinary Flow workflow fields follow
```

- Local packages live under `.flow/workflows/<name>/WORKFLOW.yaml`; a package directory contains
  only that inert regular manifest.
- The manifest is strict UTF-8 YAML with unique keys, no aliases, exact SemVer identity, bounded
  metadata, and bounded ordinary workflow source.
- Capability bundles add a `workflow-package` entry containing canonical base64 manifest bytes and
  preserve the existing canonical package ordering/digest contract.
- A reusable child uses exactly one of the existing embedded `workflow` field or a package selector:

```yaml
child:
  package: { name: release-check, version: 1.0.0 }
  resultNodeId: result
```

- Root CLI selection uses the explicit source locator `workflow:<name>@<exact-version>` with existing
  `validate`, `run`, and `resume` commands. Ordinary paths retain their current meaning.
- `flow workflows list`, `inspect <name> --version <exact>`, and `validate` expose inert catalog
  operations. Inspection omits the raw embedded workflow while reporting its byte count and digest.
- The immutable capability snapshot gains a `workflow-package` variant. The run-start contract
  records exact workflow-package requirements and identifies a packaged root source separately from
  ordinary inline source.
- Detached jobs carry exact root source, root package identity when applicable, and the complete
  immutable snapshot. Workers compile against only those bytes.
- Existing inline workflow and embedded-child compiled values are byte-for-byte unchanged because
  package identity fields are absent unless explicitly selected.

## Security invariants

1. A workflow package is never imported as a JavaScript, Python, Wasm, native, Pi, or OMP module.
2. Package source is parsed by the same strict workflow schema and compiled by the same recursive
   compiler as inline source.
3. The final compile resolver is a closed immutable snapshot; it performs no filesystem or network
   access.
4. Every referenced exact package appears once in the durable snapshot and matches name, version,
   manifest bytes, package digest, and provenance.
5. Cycles and depth/count/serialized-size expansion fail before run-store construction or executor
   invocation.
6. A package cannot supply policy, config, provider/model credentials, sandbox profiles, code
   drivers, or executable install behavior.
7. Replay and recovery reconcile compiled requirements with the run-start snapshot and refuse
   compound mutations of reference, digest, source, or root identity.

## Acceptance-criterion verification map

### AC1 — local/installed catalog operations are inert

- **Type**: behavioral and error handling
- **Command**: `npx vitest run test/unit/capability/workflow-packages.test.ts test/unit/capability/local-workflow-packages.test.ts test/unit/capability/installed-capability-catalog.test.ts test/integration/cli/workflow-packages.test.ts`
- **Expected evidence**: exact local and installed packages list/inspect/validate successfully; malformed,
  extra-file, symlink, collision, and source-race cases fail; executor calls remain zero.
- **Does not promise**: executable plugins, registry discovery, or automatic installation.

### AC2 — packaged root validate/run parity

- **Type**: behavioral
- **Command**: `npx vitest run test/integration/cli/workflow-packages.test.ts -t "packaged root"`
- **Expected evidence**: exact source locator validates and runs with the same result, diagnostics, and
  workflow rules as direct source; wrong versions and ambiguous locators fail before execution.
- **Does not promise**: template inputs, ranges, or implicit latest selection.

### AC3 — reusable child parity

- **Type**: behavioral and contract
- **Command**: `npx vitest run test/unit/workflow/workflow-package-compiler.test.ts test/unit/application/run-workflow-child.test.ts -t "package-selected child|workflow package compilation"`
- **Expected evidence**: package-selected children preserve isolation, complete budgets, typed result,
  evidence, depth/tree limits, and exact compiler diagnostics; package cycles fail.
- **Does not promise**: shared child workspaces, dynamic fan-out, or general patch promotion.

### AC4 — deterministic bundle distribution

- **Type**: data and contract
- **Command**: `npx vitest run test/unit/capability/capability-bundles.test.ts test/unit/capability/installed-capability-catalog.test.ts test/integration/cli/capability-packages.test.ts`
- **Expected evidence**: identical sources pack to identical bytes/digest; install/verify/remove round
  trips exact manifests; unsafe paths, noncanonical base64, extras, and tampering fail.
- **Does not promise**: publisher signatures, registries, updates, or dependency solving.

### AC5 — durable identity across execution modes

- **Type**: behavioral and data
- **Command**: `npx vitest run test/unit/capability/workflow-capabilities.test.ts test/unit/run/workflow-package-reducer.test.ts && npx vitest run test/integration/supervisor/worker.test.ts -t "packaged root"`
- **Expected evidence**: run start, detached job, worker, child, resume, and replay use exact admitted
  bytes after live mutation/removal; identity/provenance/digest survive each boundary.
- **Does not promise**: opaque provider-session continuation or cross-host worker migration.

### AC6 — fail-closed drift, mismatch, and collisions

- **Type**: error handling and security
- **Command**: `npx vitest run test/unit/capability/local-workflow-packages.test.ts test/unit/application/workflow-package-admission.test.ts test/unit/workflow/workflow-package-compiler.test.ts test/unit/run/workflow-package-reducer.test.ts test/integration/cli/workflow-packages.test.ts`
- **Expected evidence**: each named invalid/missing/drift/collision/snapshot mutation fails before the
  affected executor and reports a bounded stable code/message.
- **Does not promise**: recovery from corrupt authoritative history.

### AC7 — no authority escalation or package execution

- **Type**: security and contract
- **Command**: `npx vitest run test/unit/capability/workflow-packages.test.ts test/unit/capability/workflow-capabilities.test.ts test/integration/cli/workflow-packages.test.ts`
- **Expected evidence**: executable payload fields/extra files are rejected, inspection hides raw
  source, and package selection does not add tools, policy, evaluator, provider, or sandbox authority.
- **Does not promise**: containment of deliberately selected workflow commands beyond existing Flow
  policy/sandbox guarantees.

### AC8 — existing inline compatibility

- **Type**: regression and contract
- **Command**: `npx vitest run test/unit/workflow/compiler.test.ts test/unit/workflow/child-node-compiler.test.ts test/unit/workflow/workflow-package-compiler.test.ts`
- **Expected evidence**: existing fixtures compile to unchanged structures/digests and embedded child
  behavior remains green.
- **Does not promise**: stability for undocumented internal compiled representations when packages are
  explicitly selected.

### AC9 — public documentation and roadmap

- **Type**: documentation contract
- **Command**: `npx vitest run test/scaffold/community-files.test.ts && rg -n "WorkflowPackage|workflow package|workflow:" README.md SECURITY.md docs/roadmap.md docs/capability-sourcing.md docs/workflow-spec.md docs/testing-and-evaluation.md examples`
- **Expected evidence**: required public files and an example cover authoring, selection, distribution,
  trust, recovery, limits, and non-goals; roadmap wording matches actual implementation.
- **Does not promise**: policy/UI packages, signed registries, or benchmark superiority.

### AC10 — complete quality gate

- **Type**: configuration, build, runtime, security, and coverage
- **Command**: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run test:runtime && npm run test:coverage && npm run pack:check && npm audit --audit-level=high`
- **Expected evidence**: every command exits zero; coverage remains above configured thresholds; package
  contents are intentional; audit reports no high-severity finding.
- **Does not promise**: live paid-provider behavior, hostile-workload VM isolation, or product benchmark
  superiority.

## Implementation sequence

1. RED/GREEN/REFACTOR strict manifest, exact identity, snapshot, and tamper validation.
2. RED/GREEN/REFACTOR local/installed catalogs and deterministic bundle inclusion.
3. RED/GREEN/REFACTOR child reference syntax, closed resolver, cycle/depth handling, and unchanged inline
   digests.
4. RED/GREEN/REFACTOR capability binding plus run-start requirement/replay reconciliation.
5. RED/GREEN/REFACTOR root source locator, catalog commands, attached run, detached handoff, and durable
   resume.
6. Add public example and update README, security, capability sourcing, workflow spec, testing, and
   roadmap after the behavior is green.
7. Run focused checks, full local CI, runtime verification, coverage, pack/audit, self-review, and
   adversarial replay/security review until zero actionable findings.

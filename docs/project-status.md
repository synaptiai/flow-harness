# Project status

Flow is a public alpha preview. Its executable format is `flow.synapti.ai/v1alpha1`. Alpha.4 is the
first checkpoint governed by the bounded compatibility policy and historical corpus. It doesn't
claim stable support or automatic migration.

Version `0.1.0-alpha.4` is the current compatibility-governed usability checkpoint. GitHub-hosted
Ubuntu 24.04 x64 and macOS 15 Intel runners verify the same npm archive before publication. The `preview` npm
distribution tag is the registry channel. The immutable `0.1.0-alpha.2` release is GitHub-only
historical evidence because its manifest selected the wrong npm organization scope.

## Status terms

| Term | Meaning |
| --- | --- |
| Implemented | The repository contains production composition and automated verification for the stated boundary. |
| Limited | The feature works only on the named platforms, profiles, or authority boundary. |
| Planned | The repository does not claim the feature yet. |

An implemented feature can still have explicit non-goals. Read the linked contract before relying
on it.

## Platform support

| Capability | Linux | macOS | Notes |
| --- | --- | --- | --- |
| Workflow validation and inspection | Implemented | Implemented | No provider is needed for credential-free examples. |
| Offline compatibility check | Implemented | Implemented | Alpha.4 validates its packaged historical corpus without project, provider, or network access. Published alpha.3 doesn't contain this command. |
| Guided quick start | Implemented | Implemented | The current checkpoint provides credential-free, zero-tool provider, and explicit bounded coding paths with durable inspection and browser commands. |
| Read-only environment diagnostics | Implemented | Implemented | The current checkpoint checks only the selected workflow, sandbox, or Prime path. |
| Sandboxed command nodes | Implemented | Implemented | Flow fails closed when the native sandbox is unavailable. |
| Agent `read`, `ls`, exclusive `create`, nonrecursive `mkdir`, hash-bound `edit`, and version-bound complete `replace` | Implemented | Implemented | The host-side Pi runtime keeps the invoking user's host authority. |
| Read-only semantic code queries | Linux x64 runtime proof | Limited | Current source supports an exact local LSP 3.18 server under the native sandbox. The hosted containment proof covers Linux x64. |
| Agent `exec` | Implemented | Unavailable | Linux requires verified PID-namespace descendant containment. |
| Detached supervisor and workers | Implemented | Implemented | Same-host and same-user only. |
| Terminal, browser, and ACP presentation | Implemented | Implemented | Local operator surfaces only. |
| Prompt-only local ACP executor | Linux x64 runtime proof | Limited | Current source supports operator selection, attached and detached execution, fresh recovery, and provider-neutral evidence. Hosted process-containment proof covers Linux x64; macOS has source and contract coverage. |
| Paired ACP interoperability qualification | Linux x64 runtime proof | Limited | Current source supports two distinct exact local agents, one shared prompt-only workflow, private result verification, complete accounting gates, offline reports, and an opt-in production-agent proof path. No agent pair is claimed compatible without its own `qualified` report. |
| Phase-aware model routing | Implemented | Implemented | Current source supports exact root and embedded-child profiles, durable per-request decisions, held-out quality and efficiency qualification, and exact-artifact activation. ACP and learned production routing remain unavailable. |
| Bounded delegation evaluation | Implemented | Implemented | Current source supports one sealed no-argument local specialist call, durable child settlement and recovery, paired task-class reports, content-free inspection, and no activation path. Remote, recursive, parallel, and background delegation remain unavailable. |
| Exact Lean proof verification | Linux x64 only | Unavailable | Current source prepares one reproducible OCI appliance, requires exact human statement approval plus compiler, SafeVerify, Nanoda, and cleanup agreement, and provides complete profile qualification. Hosted CI builds and exercises the real appliance without provider credentials. |
| Container command profile | Linux x64 only | Unavailable | Requires the prepared Prime image and exact Docker runtime profile. |
| Prime Agent evaluation | Linux x64 only | Unavailable | Requires Docker API 1.51, cgroup v2, and the fixed host contract. |
| Reference-first compaction evaluation | Implemented | Implemented | Provider-backed held-out experiment only. It cannot activate an ordinary runtime policy. |
| Production rolling context | Implemented in current source | Implemented in current source | Explicit embedded Pi opt-in for OpenAI Responses and Anthropic Messages. Published alpha.4 doesn't include it. ACP and other adapters fail closed. |

## Implemented capability groups

### Public delivery and compatibility

- One supported npm executable named `flow` and no supported package-name JavaScript or TypeScript
  import.
- An empty npm `exports` map that rejects the package root and undeclared subpaths while preserving
  the executable.
- A versioned, immutable compatibility corpus with one alpha.1 authored workflow and one real
  alpha.1 terminal run ledger.
- A read-only `flow compatibility check` command in current source. It uses the production compiler
  and run reducer and emits a bounded, content-free report.
- A clean packed-archive gate that installs the exact archive and runs the compatibility check. The
  gate also proves that root and deep package imports fail.
- A decision-grade [library API assessment](library-api-assessment.md). It recommends no current
  library export, a possible future separate read-only workflow contract, and a later
  process-isolated client for execution.
- A separately recoverable npm staging workflow that reverifies the immutable GitHub release and
  uses a stage-only trusted publisher. Human review and two-factor approval remain outside CI.

Read the [Compatibility policy](compatibility.md) for exact surface classifications, prerelease
change rules, migration, and rollback.

### Deterministic execution and evidence

- Strict workflow and goal compilation.
- Dependency-ordered graphs with bounded concurrency, branches, joins, loops, and optimization.
- Typed result publication from durable evidence.
- Isolated child workflows with separate ledgers and bounded resource accounting.
- Append-only run ledgers, inspection, recovery, and exact replay checks.
- One append-only, project-scoped goal workspace with full revisions, exact compare-and-set updates,
  evidence references, and immutable run selection.
- Run budgets for starts, tokens, reported cost, active time, and retained artifacts.
- Durable `fast`, `standard`, and `long` work profiles with read-only remaining-budget guidance for
  model-backed attempts.
- Private, bounded, provider-neutral model-session records with write-ahead request identity,
  completed user/model/tool context, redacted inspection, and fresh-turn recovery context.
- Reference-first projection and bounded summary lifecycle with a dedicated three-mode held-out
  evaluator. Its reports don't activate a runtime policy.
- Production rolling context in current source for explicitly opted-in embedded Pi agents. Flow
  measures the serialized request and keeps the complete private ledger. It preserves a two-request
  exact tail and reconstructs accepted checkpoints after restart. The published alpha.4 package
  doesn't include this policy.
- Content-addressed oversized command output with immutable producer references, bounded same-run
  reads, operator inspection, shared retention, and exact-plan pruning.
- Guided credential-free, zero-tool provider, and bounded provider-backed coding quick starts.

The coding path supports explicit Anthropic and OpenAI preview selections in an empty directory. It
uses only read, list, exclusive create, and hash-bound edit tools, then requires deterministic
verification. Read [Complete the coding quick start](guides/coding-quickstart.md).

Two adaptive field series against separate-repository issues produced reviewed, merged candidates.
The first needed nine full attempts. The second needed 11 full attempts and four bounded repair
workflows. Its successful candidate chain still required operator-authored repair selection. These
results don't establish general unattended coding.

They also don't establish autonomous recursive-repair effectiveness.
Read the [issue 4 field report](field-reports/digital-twin-issue-4-alpha4.md) and
[issue 5 field report](field-reports/digital-twin-issue-5-alpha4.md) for fixed controls, complete
denominators, evidence, and limitations.

Read [Run and control workflows](guides/run-and-control.md),
[Maintain a durable goal workspace](guides/goal-workspaces.md),
[Retain and inspect command artifacts](guides/retained-artifacts.md),
[Inspect and recover portable model sessions](guides/model-sessions.md),
[Keep long model sessions within provider capacity](guides/rolling-context.md),
[Evaluate reference-first context compaction](guides/context-compaction.md), the
[Workflow specification](workflow-spec.md), and [Architecture](architecture.md).

### Semantic code context

- Operator-selected language-server identity in the immutable run capability snapshot.
- Bounded diagnostics, definition, references, and hover operations through `flow_semantic`.
- One short-lived, network-denied, read-only project projection for each query.
- Source-currentness checks and canonical receipts after confirmed process and sandbox settlement.
- Content-free public summaries. Complete bounded receipts remain in the private run ledger.

Read [Use read-only semantic code queries](guides/semantic-code.md).

### Exact proof verification

- One exact Linux x64 OCI runtime built twice from pinned Lean, Mathlib, checker, base-image,
  BuildKit, seccomp, and profile inputs.
- Optional provider-neutral proof generation through one exact operator-selected model route with
  deny fallback.
- Separate bounded specification, exact theorem or lemma header, proof term, and human
  specification-to-statement approval.
- Compiler, exact declaration and type, SafeVerify kernel replay, closed axiom policy, independent
  Nanoda checking, and confirmed cleanup before acceptance.
- No runtime network, credentials, host project mount, or ambient home, with effective Linux policy
  checks and a durable recovery lease.
- Content-free public inspection and three-state profile qualification with explicit proof,
  faithfulness, ordinary-test, cost, latency, policy, cleanup, and missingness coverage.

Read [Verify an exact Lean statement](guides/lean-proof-verification.md) and
[Operate the Lean proof runtime](operations/lean-proof-runtime.md).

### Policy, approval, and containment

- Strict project and operator configuration.
- Sandboxed argv-only command execution with no task network.
- Exact command approval, live agent-command approval, and evidence-bound graph approval.
- Provider-neutral policy decisions and policy-package narrowing.
- Higher-isolation container commands on the admitted Linux x64 profile.

Read [Configuration](configuration.md), [Run and control workflows](guides/run-and-control.md), and
the [Security policy](../SECURITY.md).

### Durable operation

- Attached and detached execution.
- Durable FIFO admission, authenticated workers, cancellation, and event replay.
- Proof-gated fresh recovery for eligible interrupted agent attempts and completed provider
  failures. A failed attempt can preserve earlier committed workspace edits only through the exact
  durable model-session continuation gate.
- Explicit bounded recovery for a completed, nontruncated model-verifier response that violates the
  strict verdict JSON contract. Semantic verdicts and open verifier attempts remain nonretryable.
- Terminal, browser, and ACP v1 observation and steering.
- Exact local ACP v1 executor selection for attached and detached runs.
- One fresh contained process and session for each attempt.
- Exact model configuration, prompt-only authority, provider-neutral evidence, truthful usage, and
  proof-gated fresh recovery.
- Paired qualification for two distinct exact ACP agents with one shared workflow, private typed
  result verification, and complete accounting. Reports distinguish qualified, not-qualified, and
  insufficient-evidence outcomes.

Read [Recovery and interruption safety](recovery.md), [Local ACP v1 bridge](acp.md), and
[Run and control workflows](guides/run-and-control.md). Read
[Qualify two local ACP agents](guides/qualify-acp-agents.md) for paired production-agent proof.

### Portable capabilities

- A generated, versioned reference for built-in model tools, schemas, public limits, package
  families, and provider and evaluation seams. The read-only local and CI gate rejects drift from
  production composition.

#### Package types and distribution

- Agent Skills.
- Command and model verifier packages.
- Declarative command tool packages.
- Workflow, policy, and A2UI-profile presentation packages.
- Deterministic `.flowpkg` bundles.
- Public HTTPS and publisher-authenticated OCI acquisition.

#### Package governance

- Signed metadata, TUF repositories, review candidates, activation, replacement, finite first
  activation, and bounded update watching.
- Explicit retired-blob preview and digest-bound pruning with bounded physical storage and
  generation-safe readers on Linux and macOS.

Read [Tools and capabilities](reference/tools-and-capabilities.md),
[Use capability packages](guides/capability-packages.md), and
[Capability sourcing](capability-sourcing.md).

### Evaluation and adaptation

- Paired Flow, native Pi, native OMP, and Prime Agent evaluation profiles.
- Exact phase-aware routing candidates with immutable `before` and `after` profiles, durable
  request decisions, held-out qualification, and purpose-specific activation.
- One bounded delegation experiment that compares the same manager with and without a sealed local
  specialist. It limits depth and calls to one, reuses isolated child ledgers, reports task classes
  and child resources, and cannot activate.
- Balanced no-compaction, reference-only, and reference-plus-summary evaluation with deterministic
  protected-constraint evidence.
- Private deterministic verification and constrained comparison reports.
- Prompt, Agent Skill resource, Agent Skill package, static model-routing, and embedded
  child-specialist candidates, plus immutable per-agent supplemental-memory candidates and bounded
  model-suggested add or replacement proposals.
- Evidence-backed supplemental-memory relationships with closed predicates, atomic incident-edge
  rebinding, explicit unresolved contradictions, exact-target model context, and content-free public
  integrity summaries.
- Reviewed activation, durable snapshots, offline inspection, recovery, replay, and rollback.

Read [Manage supplemental-memory relationships](guides/supplemental-memory-relationships.md),
[Evaluate and activate phase-aware model routing](guides/phase-routing.md),
[Evaluate bounded one-shot delegation](guides/evaluate-bounded-delegation.md),
[Reproducible harness evaluation](evaluation.md), and
[Testing and evaluation](testing-and-evaluation.md).

## Planned boundaries

- Executable or remote UI extensions.
- Model-owned network tools.
- A broader Flow-brokered ACP authority profile beyond prompt-only qualification.
- Remote or multi-host supervisor control.
- VM-grade isolation for the host-side agent runtime.
- A stable executable format and migration promise.
- A stable npm release or hosted Flow service.

The [Delivery roadmap](roadmap.md) records completed gates and planned work. It does not replace the
current support and security contracts on this page. Read
[Next-version capability research](next-version-research.md) for the consolidated deferred-capability
register, dependency order, and release-shaping alternatives.

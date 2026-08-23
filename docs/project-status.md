# Project status

Flow is a public alpha preview. Its executable format is
`flow.synapti.ai/v1alpha1`. There is no compatibility or migration promise before the first stable
release.

Version `0.1.0-alpha.1` is the first installable preview. GitHub-hosted Ubuntu 24.04 x64 and macOS
15 Intel runners verify the same npm archive before publication. The `preview` npm distribution
tag is the registry channel after its initial two-factor-authenticated bootstrap.

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
| Guided quick start | Implemented | Implemented | Current source builds provide credential-free, zero-tool provider, and explicit bounded coding paths with durable inspection and browser commands. |
| Read-only environment diagnostics | Implemented | Implemented | Available in current source builds; optional checks run only for the selected workflow, sandbox, or Prime path. |
| Sandboxed command nodes | Implemented | Implemented | Flow fails closed when the native sandbox is unavailable. |
| Agent `read`, `ls`, and hash-bound `edit` | Implemented | Implemented | The host-side Pi runtime keeps the invoking user's host authority. |
| Read-only semantic code queries | Linux x64 runtime proof | Limited | Current source supports an exact local LSP 3.18 server under the native sandbox. The hosted containment proof covers Linux x64. |
| Agent `exec` | Implemented | Unavailable | Linux requires verified PID-namespace descendant containment. |
| Detached supervisor and workers | Implemented | Implemented | Same-host and same-user only. |
| Terminal, browser, and ACP presentation | Implemented | Implemented | Local operator surfaces only. |
| Prompt-only local ACP executor | Linux x64 runtime proof | Limited | Current source supports operator selection, attached and detached execution, fresh recovery, and provider-neutral evidence. Hosted process-containment proof covers Linux x64; macOS has source and contract coverage. |
| Container command profile | Linux x64 only | Unavailable | Requires the prepared Prime image and exact Docker runtime profile. |
| Prime Agent evaluation | Linux x64 only | Unavailable | Requires Docker API 1.51, cgroup v2, and the fixed host contract. |
| Reference-first compaction evaluation | Implemented | Implemented | Provider-backed held-out experiment only. It cannot activate an ordinary runtime policy. |

## Implemented capability groups

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
  evaluator. Ordinary runs don't activate compaction.
- Content-addressed oversized command output with immutable producer references, bounded same-run
  reads, operator inspection, shared retention, and exact-plan pruning.
- Guided credential-free, zero-tool provider, and bounded provider-backed coding quick starts.

The coding path supports explicit Anthropic and OpenAI preview selections in an empty directory. It
uses only read, list, and hash-bound edit tools, then requires deterministic exact-byte
verification. Read [Complete the coding quick start](guides/coding-quickstart.md).

Read [Run and control workflows](guides/run-and-control.md),
[Maintain a durable goal workspace](guides/goal-workspaces.md),
[Retain and inspect command artifacts](guides/retained-artifacts.md),
[Inspect and recover portable model sessions](guides/model-sessions.md),
[Evaluate reference-first context compaction](guides/context-compaction.md), the
[Workflow specification](workflow-spec.md), and [Architecture](architecture.md).

### Semantic code context

- Operator-selected language-server identity in the immutable run capability snapshot.
- Bounded diagnostics, definition, references, and hover operations through `flow_semantic`.
- One short-lived, network-denied, read-only project projection for each query.
- Source-currentness checks and canonical receipts after confirmed process and sandbox settlement.
- Content-free public summaries. Complete bounded receipts remain in the private run ledger.

Read [Use read-only semantic code queries](guides/semantic-code.md).

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
- Proof-gated fresh recovery for eligible interrupted agent attempts.
- Terminal, browser, and ACP v1 observation and steering.
- Exact local ACP v1 executor selection for attached and detached runs.
- One fresh contained process and session for each attempt.
- Exact model configuration, prompt-only authority, provider-neutral evidence, truthful usage, and
  proof-gated fresh recovery.

Read [Recovery and interruption safety](recovery.md), [Local ACP v1 bridge](acp.md), and
[Run and control workflows](guides/run-and-control.md).

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
[Reproducible harness evaluation](evaluation.md), and
[Testing and evaluation](testing-and-evaluation.md).

## Planned boundaries

- Executable or remote UI extensions.
- Model-owned network tools.
- Cross-agent ACP interoperability evaluation and any broader brokered authority profile.
- Remote or multi-host supervisor control.
- VM-grade isolation for the host-side agent runtime.
- A stable executable format and migration promise.
- A stable npm release or hosted Flow service.

The [Delivery roadmap](roadmap.md) records completed gates and planned work. It does not replace the
current support and security contracts on this page.

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
| Agent `exec` | Implemented | Unavailable | Linux requires verified PID-namespace descendant containment. |
| Detached supervisor and workers | Implemented | Implemented | Same-host and same-user only. |
| Terminal, browser, and ACP presentation | Implemented | Implemented | Local operator surfaces only. |
| Container command profile | Linux x64 only | Unavailable | Requires the prepared Prime image and exact Docker runtime profile. |
| Prime Agent evaluation | Linux x64 only | Unavailable | Requires Docker API 1.51, cgroup v2, and the fixed host contract. |

## Implemented capability groups

### Deterministic execution and evidence

- Strict workflow and goal compilation.
- Dependency-ordered graphs with bounded concurrency, branches, joins, loops, and optimization.
- Typed result publication from durable evidence.
- Isolated child workflows with separate ledgers and bounded resource accounting.
- Append-only run ledgers, inspection, recovery, and exact replay checks.
- Run budgets for starts, tokens, reported cost, active time, and retained artifacts.
- Guided credential-free, zero-tool provider, and bounded provider-backed coding quick starts.

The coding path supports explicit Anthropic and OpenAI preview selections in an empty directory. It
uses only read, list, and hash-bound edit tools, then requires deterministic exact-byte
verification. Read [Complete the coding quick start](guides/coding-quickstart.md).

Read the [Workflow specification](workflow-spec.md) and [Architecture](architecture.md).

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

Read [Recovery and interruption safety](recovery.md), [Local ACP v1 bridge](acp.md), and
[Run and control workflows](guides/run-and-control.md).

### Portable capabilities

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

Read [Use capability packages](guides/capability-packages.md) and
[Capability sourcing](capability-sourcing.md).

### Evaluation and adaptation

- Paired Flow, native Pi, native OMP, and Prime Agent evaluation profiles.
- Private deterministic verification and constrained comparison reports.
- Prompt, Agent Skill resource, Agent Skill package, static model-routing, and embedded
  child-specialist candidates, plus immutable per-agent supplemental-memory candidates and bounded
  model-suggested add or replacement proposals.
- Reviewed activation, durable snapshots, offline inspection, recovery, replay, and rollback.

Read [Reproducible harness evaluation](evaluation.md) and
[Testing and evaluation](testing-and-evaluation.md).

## Planned boundaries

- Executable or remote UI extensions.
- Model-owned network tools.
- Remote or multi-host supervisor control.
- VM-grade isolation for the host-side agent runtime.
- A stable executable format and migration promise.
- A stable npm release or hosted Flow service.

The [Delivery roadmap](roadmap.md) records completed gates and planned work. It does not replace the
current support and security contracts on this page.

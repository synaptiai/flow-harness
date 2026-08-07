# Capability sourcing

## Decision

Flow owns every semantic that determines whether work is allowed, contained, complete, recoverable, or correct. Pi initially supplies the model-facing machinery. Anthropic Sandbox Runtime (SRT) supplies the first command-containment primitive behind a Flow-owned port. OMP and Prime Agent are reference implementations and possible sources for carefully isolated future capability packages.

The first runtime will embed [`@earendil-works/pi-coding-agent`](https://pi.dev/docs/latest/sdk) behind a narrow Flow-owned executor. The package is pinned exactly and all events are translated before persistence.

Pi's experimental `AgentHarness` API is not a foundation for the first release. Pi v0.84.0 describes unfinished paths that reject with `HarnessNotImplemented`; Flow will use the established `createAgentSession()` API instead. See the [Pi v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0).

## Native Flow capabilities

| Capability | Why Flow owns it |
| --- | --- |
| Workflow schema and compiler | Workflow files must compile into executable graph state rather than advice to a model |
| Scheduler and lifecycle | Readiness, conditions, bounded loop checks, proof-safe fresh attempts, future retries, joins, and terminal states are product semantics |
| Typed node inputs and outputs | Transitions must not depend on parsing persuasive prose |
| Goals, budgets, and loop termination | Flow now durably owns start, token, reported-cost, and active-time boundaries; exhausted resources never imply successful completion |
| Evidence and evaluation | A worker cannot authoritatively grade its own work |
| Policy, approvals, tool broker, and sandbox profile | Authorization and containment are Flow product semantics even when enforcement is delegated |
| Context assembly and redaction | Context composition is a major cost, safety, and quality control |
| Event ledger and recovery | Pi transcripts cannot determine graph position or side-effect certainty |
| Local supervisor and worker protocol | Flow must supervise command and agent nodes, preserve ledger authority, and expose provider-neutral control |
| Model routing | Flow selects capability and cost profiles while Pi supplies models |
| Skill and package trust | Installed content is untrusted and cannot broaden its own authority |
| Public CLI, API, and persisted formats | Public contracts must survive provider and executor changes |
| Benchmarks and accounting | One format is required to compare providers and future executors |

## Imported from Pi

| Capability | Initial use | Boundary |
| --- | --- | --- |
| Multi-provider inference | Import through Pi's model runtime | Persist only Flow model requirements and provider/model identifiers |
| Authentication and model catalog | Reuse | Keep credentials and provider details outside workflow files |
| Agent tool-call loop | `createAgentSession()` | One adapter owns every Pi import; Pi assistant-turn and provider retries are explicitly disabled so Flow owns attempt count |
| Streaming events | Subscribe and translate | Persist versioned Flow events, not raw Pi events |
| Cancellation and idle settlement | Reuse mechanics | Map into Flow node lifecycle semantics |
| Concurrent tool calls | Reference implementation only | Pi may run independent tool calls concurrently, but Flow owns graph admission, quiescent waves, durable ordering, failure, and recovery semantics |
| Per-node model and thinking level | Reuse execution support | Selection remains Flow policy |
| Exact tool allowlists | Current defense in depth | The adapter passes the exact allowlist to Pi; Flow's broker remains the per-call authorization boundary |
| Basic coding tools | Flow-owned workspace-confined `read`, `ls`, and hash-anchored `edit` definitions built on Pi's custom-tool interface | Pi's built-in edit, fuzzy matching, direct writes, ambient path access, and helper-binary downloads are disabled; Flow owns policy, atomic replacement, and receipts |
| Custom tool API | Present Flow broker tools to the model | Tool schemas remain Flow-owned |
| Context transformation and compaction | Reuse mechanics | Durable state remains outside context |
| Session usage statistics | Translate `getSessionStats()` after settlement | Persist only Flow token components and integer micro-USD; Pi totals and transcripts are not authoritative |
| Session storage | Optional diagnostic artifact | Never authoritative run state; fresh recovery deliberately creates a new in-memory session rather than reopening a Pi transcript |
| TUI primitives | Optional presentation dependency | Flow owns navigation, language, and approvals |

Pi is MIT-licensed. Its fast release cadence and breaking changes create meaningful update risk, so Flow pins exact versions and maintains adapter conformance tests. See the [Pi repository](https://github.com/earendil-works/pi) and [agent-core documentation](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md).

## Imported containment primitive

Pi's official containment documentation demonstrates three useful deployment shapes: an SRT extension for lightweight native isolation, a Gondolin extension that routes tools into a Linux microVM, and container or managed sandbox deployment. Flow adopts the proven adapter seam, not Pi's extension policy.

The first adapter pins [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) exactly. SRT provides Seatbelt enforcement on macOS and bubblewrap, network namespaces, and seccomp enforcement on Linux. Flow adds the security semantics required by its harness contract:

- no unsandboxed fallback;
- no default network allowlist;
- no inherited environment or provider credentials;
- protection for the actual run store and sensitive project state;
- fatal handling of dependency warnings that indicate degraded isolation;
- required teardown before success; and
- durable backend, version, profile, and policy-digest evidence.

SRT is a beta native sandbox, so it is not the final answer for hostile multi-tenant work. The `CommandSandbox` port preserves a path to [Gondolin](https://github.com/earendil-works/gondolin), OpenShell, containers, or remote sandboxes when a VM-grade or centrally managed boundary is required.

## Learned or selectively ported from OMP

OMP is a Pi fork with a broad TypeScript, Bun, and Rust-native product surface. Importing it alongside upstream Pi would create two diverging copies of the same agent abstractions. Flow will not depend on OMP initially.

| Capability | Treatment |
| --- | --- |
| Read/write/exec approval tiers | Exact expiring command pre-start approval and evidence-bound graph approval are implemented independently; configurable tiers and dynamic model-tool prompting remain future work; approval never substitutes for containment |
| Hash-anchored edits | The first single-file full-SHA exact-edit tool is independently implemented with provenance receipts; OMP's compact line protocol, snapshots, stale recovery, and multi-file patcher remain benchmark candidates rather than dependencies |
| Diagnostics after writes | Add through an optional language-service capability |
| LSP and debugger operations | Optional first-party packages, outside scheduler core |
| Worktree-isolated subagents | Adopt the isolation pattern while Flow owns fan-out and joins |
| Bounded tool-output summaries | Implement in Flow's artifact and evidence layer |
| Model-specific tool and prompt tuning | Represent as benchmarked routing profiles |
| Stream-triggered correction | Experimental only because retries can duplicate effects |
| Native shell/search/coreutils | Do not port without profiling evidence |
| Persistent code kernels | Optional sandboxed capability, never a default |
| Advisor model | Represent explicitly as a review or evaluator node |
| Thinking budgets and tool timeouts | Retain as lower-level runtime controls; Flow-owned run budgets remain the durable cross-node authority |

See the [OMP repository](https://github.com/can1357/oh-my-pi), [SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md), and [approval model](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md). OMP is MIT-licensed; copied code must retain the applicable Pi and OMP notices and per-file provenance.

## Learned or selectively ported from Prime Agent

Prime Agent proves that Pi can support a distinct long-running harness. Its product center is a persistent IPython Recursive Language Model and continual harness refinement, which is not Flow's product center.

| Capability | Treatment |
| --- | --- |
| Supervisor and one worker per root run tree | **Implemented independently** for one local worker per run/resume invocation; the worker owns the existing Flow scheduler |
| Detach, reattach, snapshots, and event replay | **Implemented independently** with immutable source snapshots, authenticated adoption, and bounded exclusive sequence cursors |
| Recovery journal and bounded restart | **Implemented for supervisor restart, idempotent cancellation, write-ahead Flow edit evidence, typed hash/mode observation, and proof-safe fresh agent attempts** around Flow's authoritative run ledger; Prime's fail-closed treatment of uncertain side effects is retained, so only replay-proven not-applied attempts qualify |
| Durable goals and autonomous continuation | Implement in Flow's scheduler |
| Daemon workload limits | Prime leaves fixed caps outside its daemon layer; Flow independently adds strict operator/project ceilings, durable active reservations, a bounded FIFO queue, deterministic overflow rejection, and per-run graph-node concurrency. Artifact limits remain |
| Heartbeats and schedules | Later trigger package now that bounded admission exists; triggers must not bypass the same queue |
| Retained children and messaging | Represent as graph-owned child runs and mailbox events |
| Persistent IPython | Optional capability only; never describe it as a sandbox |
| Recursive subagents | Use narrow contexts but keep recursion and joins graph-owned |
| Executable Python skills | Defer because installation expands the supply-chain boundary |
| Continual harness refinement | Future candidate system requiring evaluation, approval, versioning, and rollback |
| Immutable base plus supplemental state | Adopt as the boundary for any future learning system |

See [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), its [architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md), and its [RLM trust model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md). Prime Agent is MIT-licensed; substantial copied portions require preservation of both Pi and Prime notices.

Flow follows Prime Agent's proven client/supervisor/worker separation but does not import its
Python RLM, graph state, protocol, or code. Pi remains embedded through its typed TypeScript SDK
inside each worker because Pi's RPC process would supervise only the inner model session, not Flow
command nodes, approvals, budgets, evidence, or recovery. OMP's background jobs similarly inform
cancellation mechanics but are not a reusable whole-harness daemon.

For graph concurrency, Flow also compared three proven shapes: Pi's fixed-worker concurrent tool
dispatch, OMP's session semaphore and independently registered background jobs, and workflow-engine
quiescence such as Argo DAG scheduling. Flow adopts bounded admission and wait-for-running-work
quiescence, but not Pi/OMP completion-order persistence or background-job ownership: dependency
release, failure selection, cancellation projection, and recovery stay ledger-owned and
declaration-ordered.

## Retry and recovery ownership

Flow uses one retry authority rather than stacking independent retry loops. The pinned Pi settings
default to assistant-turn retry, and its provider settings can add a lower transport retry layer.
The adapter explicitly sets both maxima to zero. A provider or terminal model error therefore
settles the current Flow node outcome; it is not silently replayed beneath the ledger. This follows
the general reliability rule to retry at one layer because nested retries multiply calls. See the
[AWS retry-control guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html).

Pi persistent sessions and OMP session logs can reconstruct conversational context, but neither is
Flow's fsync boundary for graph state, resource accounting, or effect settlement. OMP also removes
dangling tool calls when constructing safe context, which makes its transcript useful diagnostic
input but not proof that a missing tool result had no effect. Flow consequently chose a new Pi
session for each fresh attempt and archives the previous attempt only in Flow's event model. See
[OMP session storage](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md).

Prime Agent's daemon journals mutating client commands before dispatch and does not replay an
uncertain side effect merely because its durable result is missing. Flow applies the same principle
inside the agent node: automatic fresh recovery is legal only for read-only attempts or durable
edits whose every effect is positively proven `not_applied`. Applied, committed, open, and unknown
states remain blocked. See [Prime Agent daemon
semantics](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)
and [AWS idempotency guidance](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/).

## Portable skills

Flow will support the open [Agent Skills specification](https://agentskills.io/specification), not Claude-specific discovery rules.

Additional Flow rules:

- Validate packages before indexing.
- Load metadata during discovery and full instructions only for selected nodes.
- Treat `allowed-tools` as a request, never authorization.
- Record provenance, digest, version, license, dependencies, and trust state.
- Execute skill code through the same policy and sandbox boundary as every other tool.
- Prevent packages from directly changing transitions or evaluator definitions.

## Coupling rules

- No Pi, OMP, Prime Agent, or provider type appears in a persisted workflow or public Flow API.
- No domain module imports an executor or infrastructure implementation.
- No tool implementation advances a workflow.
- No model session writes authoritative run state.
- No package increases its own authority.
- No executor declares its output accepted.
- No retry repeats an unresolved consequential side effect.
- Only infrastructure adapters and composition code may import Pi or sandbox-runtime packages.

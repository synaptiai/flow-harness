# Capability sourcing

## Decision

Flow owns every semantic that determines whether work is allowed, contained, complete, recoverable, or correct. Pi initially supplies the model-facing machinery. Anthropic Sandbox Runtime (SRT) supplies the first command-containment primitive behind a Flow-owned port. OMP and Prime Agent are reference implementations and possible sources for carefully isolated future capability packages.

The first runtime will embed [`@earendil-works/pi-coding-agent`](https://pi.dev/docs/latest/sdk) behind a narrow Flow-owned executor. The package is pinned exactly and all events are translated before persistence.

Pi's experimental `AgentHarness` API is not a foundation for the first release. Pi v0.84.0 describes unfinished paths that reject with `HarnessNotImplemented`; Flow will use the established `createAgentSession()` API instead. See the [Pi v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0).

## Native Flow capabilities

| Capability | Why Flow owns it |
| --- | --- |
| Workflow schema and compiler | Workflow files must compile into executable graph state rather than advice to a model |
| Scheduler and lifecycle | Readiness, conditions, loops, retries, joins, and terminal states are product semantics |
| Typed node inputs and outputs | Transitions must not depend on parsing persuasive prose |
| Goals, budgets, and loop termination | Exhausted resources never imply successful completion |
| Evidence and evaluation | A worker cannot authoritatively grade its own work |
| Policy, approvals, tool broker, and sandbox profile | Authorization and containment are Flow product semantics even when enforcement is delegated |
| Context assembly and redaction | Context composition is a major cost, safety, and quality control |
| Event ledger and recovery | Pi transcripts cannot determine graph position or side-effect certainty |
| Model routing | Flow selects capability and cost profiles while Pi supplies models |
| Skill and package trust | Installed content is untrusted and cannot broaden its own authority |
| Public CLI, API, and persisted formats | Public contracts must survive provider and executor changes |
| Benchmarks and accounting | One format is required to compare providers and future executors |

## Imported from Pi

| Capability | Initial use | Boundary |
| --- | --- | --- |
| Multi-provider inference | Import through Pi's model runtime | Persist only Flow model requirements and provider/model identifiers |
| Authentication and model catalog | Reuse | Keep credentials and provider details outside workflow files |
| Agent tool-call loop | `createAgentSession()` | One adapter owns every Pi import |
| Streaming events | Subscribe and translate | Persist versioned Flow events, not raw Pi events |
| Cancellation and idle settlement | Reuse mechanics | Map into Flow node lifecycle semantics |
| Per-node model and thinking level | Reuse execution support | Selection remains Flow policy |
| Exact tool allowlists | Current defense in depth | The adapter passes the exact allowlist to Pi; Flow's broker remains the per-call authorization boundary |
| Basic coding tools | Flow-owned workspace-confined `read`, `ls`, and hash-anchored `edit` definitions built on Pi's custom-tool interface | Pi's built-in edit, fuzzy matching, direct writes, ambient path access, and helper-binary downloads are disabled; Flow owns policy, atomic replacement, and receipts |
| Custom tool API | Present Flow broker tools to the model | Tool schemas remain Flow-owned |
| Context transformation and compaction | Reuse mechanics | Durable state remains outside context |
| Session storage | Optional diagnostic artifact | Never authoritative run state |
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
| Read/write/exec approval tiers | Reimplement fail-closed, with argument-dependent authority; do not confuse approval with containment |
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

See the [OMP repository](https://github.com/can1357/oh-my-pi), [SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md), and [approval model](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md). OMP is MIT-licensed; copied code must retain the applicable Pi and OMP notices and per-file provenance.

## Learned or selectively ported from Prime Agent

Prime Agent proves that Pi can support a distinct long-running harness. Its product center is a persistent IPython Recursive Language Model and continual harness refinement, which is not Flow's product center.

| Capability | Treatment |
| --- | --- |
| Supervisor and one worker per root run tree | Adopt after the in-process vertical slice is stable |
| Detach, reattach, snapshots, and event replay | Use as a design reference for a future daemon protocol |
| Recovery journal and bounded restart | Reimplement around Flow's authoritative run ledger |
| Durable goals and autonomous continuation | Implement in Flow's scheduler |
| Heartbeats and schedules | Later trigger package after concurrency policy exists |
| Retained children and messaging | Represent as graph-owned child runs and mailbox events |
| Persistent IPython | Optional capability only; never describe it as a sandbox |
| Recursive subagents | Use narrow contexts but keep recursion and joins graph-owned |
| Executable Python skills | Defer because installation expands the supply-chain boundary |
| Continual harness refinement | Future candidate system requiring evaluation, approval, versioning, and rollback |
| Immutable base plus supplemental state | Adopt as the boundary for any future learning system |

See [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), its [architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md), and its [RLM trust model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md). Prime Agent is MIT-licensed; substantial copied portions require preservation of both Pi and Prime notices.

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

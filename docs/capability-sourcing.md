# Capability sourcing

## Decision

Flow owns all authority, lifecycle, evidence, and replay semantics. Pi supplies the default model
runtime. SRT contains command and native Pi or OMP processes. OMP supplies one optional evaluation
profile. Prime Agent supplies one optional OCI evaluation profile.

The first runtime embeds [`@earendil-works/pi-coding-agent`](https://pi.dev/docs/latest/sdk) behind a narrow Flow-owned executor. The package is pinned exactly and all events are translated before persistence.

Pi's experimental `AgentHarness` API is not a foundation for the first release. Pi v0.84.0 describes unfinished paths that reject with `HarnessNotImplemented`; Flow will use the established `createAgentSession()` API instead. See the [Pi v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0).

## Native Flow capabilities

| Capability | Why Flow owns it |
| --- | --- |
| Workflow schema and compiler | Workflow files must compile into executable graph state rather than advice to a model |
| Scheduler and lifecycle | Readiness, conditions, bounded loop checks, optimization checks, proof-safe fresh attempts, future retries, joins, and terminal states are product semantics |
| Typed node inputs and outputs | Flow validates bounded strict JSON, owns canonicalization and hashes, and prevents transitions from depending on persuasive prose |
| Goals, budgets, and loop termination | Flow now durably owns start, token, reported-cost, and active-time boundaries; exhausted resources never imply successful completion |
| Evidence and evaluation | A worker cannot authoritatively grade its own work |
| Policy, approvals, tool broker, and sandbox profile | Authorization and containment are Flow product semantics even when enforcement is delegated |
| Context assembly and redaction | Context composition is a major cost, safety, and quality control |
| Event ledger and recovery | Pi transcripts cannot determine graph position or side-effect certainty |
| Candidate evaluation and promotion | Metrics, invariants, stale-parent refusal, rollback, settlement, and accept-best state must remain provider-neutral replay semantics |
| Local supervisor and worker protocol | Flow must supervise command, agent, and verifier nodes, preserve ledger authority, and expose provider-neutral control |
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
| Basic coding tools | Flow-owned workspace-confined `read`, `ls`, hash-anchored `edit`, and sandboxed argv-only `exec` definitions built on Pi's custom-tool interface | Pi's built-in edit and bash tools, fuzzy matching, direct writes, ambient path access, and helper-binary downloads are disabled; Flow owns policy, atomic replacement, command/effect journals, containment, and evidence |
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
- Linux agent commands require one canonical root-owned Bubblewrap executable outside the
  workspace, and the returned descriptor must bind that exact path plus PID-namespace and
  parent-death controls in a canonical, position-checked launch shape;
- macOS process-group preparation is insufficient for agent commands and fails before spawn;
- no default network allowlist;
- no inherited environment or provider credentials;
- protection for the actual run store and sensitive project state;
- fatal handling of dependency warnings that indicate degraded isolation;
- required teardown before success; and
- durable backend, version, profile, and policy-digest evidence.

SRT is a beta native sandbox, so it is not the final answer for hostile multi-tenant work. The `CommandSandbox` port preserves a path to [Gondolin](https://github.com/earendil-works/gondolin), OpenShell, containers, or remote sandboxes when a VM-grade or centrally managed boundary is required.

## Imported and learned from OMP

OMP is a Pi fork with a TypeScript, Bun, and Rust-native product surface. Flow installs the two OMP
packages as development dependencies. It exposes them as optional peer dependencies for users. The
packages load only for the native OMP evaluation path.

Flow runs a pinned OMP agent session in a separate Bun process under Linux SRT. The session uses a
Flow-owned provider stream. Provider credentials stay in the Flow host. The profile exposes wrapped
OMP `read` and `edit` tools for the trial workspace only.

| Capability | Treatment |
| --- | --- |
| Read/write/exec approval tiers | Exact expiring command pre-start approval, evidence-bound graph approval, and durable policy authorization for agent `exec` are implemented independently; configurable tiers and dynamic model-tool prompting remain future work; approval never substitutes for containment |
| Hash-anchored edits | The first single-file full-SHA exact-edit tool is independently implemented with provenance receipts; OMP's compact line protocol, snapshots, stale recovery, and multi-file patcher remain benchmark candidates rather than dependencies |
| Diagnostics after writes | Add through an optional language-service capability |
| LSP and debugger operations | Optional first-party packages, outside scheduler core |
| Worktree-isolated subagents | **Pattern adopted independently** through bounded child snapshots and optimization candidates while Flow owns fan-out, joins, typed deltas, and promotion |
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
| Retained children and messaging | Isolated child runs and bounded optimization-candidate retention are implemented as graph-owned state; general mailboxes remain future work |
| Persistent IPython | Implemented only in the fixed Prime OCI evaluation profile. Docker policy, not IPython, supplies the containment boundary |
| Recursive subagents | Use narrow contexts but keep recursion and joins graph-owned |
| Executable Python skills | Defer because installation expands the supply-chain boundary |
| Continual harness refinement | **Partially implemented independently** for prompt candidates, paired evaluation, reviewed activation, durable run snapshots, and rollback. Model-driven proposals and other adaptation surfaces remain future work |
| Immutable base plus supplemental state | Adopt as the boundary for any future learning system |

See [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), its [architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md), and its [RLM trust model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md). Prime Agent is MIT-licensed; substantial copied portions require preservation of both Pi and Prime notices.

Prime Agent shows the value of an immutable base with supplemental refinements. Flow narrows that
pattern. A prompt candidate has no Python or runtime authority. It cannot apply itself. It must bind
the exact tuning evidence and baseline.

Flow uses its standard compiler and paired evaluation gate. An operator can activate only a complete
superior evaluation. The activation store keeps immutable artifacts, durable run snapshots, and
rollback history. Flow does not import Prime's refiner, state format, IPython kernel, or direct-apply
behavior.

Flow follows Prime Agent's client, supervisor, and worker separation. The optional OCI profile uses
the upstream Prime SDK and persistent IPython session. It does not use Prime graph state, daemon
protocol, refiner, or direct-apply behavior. Pi remains embedded through its typed TypeScript SDK
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
edits whose every effect is positively proven `not_applied`. Agent attempts with arbitrary `exec`
are categorically ineligible because no general observation can prove a command was not applied.
Applied, committed, open, and unknown
states remain blocked. See [Prime Agent daemon
semantics](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)
and [AWS idempotency guidance](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/).

## Portable skills

**Implemented for strict local and digest-pinned installed project packages.** Flow supports the open [Agent Skills
specification](https://agentskills.io/specification), not Claude-specific discovery rules. A
workflow explicitly selects packages by name; Flow snapshots the exact bounded content before run
admission and progressively exposes selected resources through its existing `flow_read` tool.

Additional Flow rules:

- Validate strict manifests, size limits, regular-file identity, symlink refusal, and package names
  before indexing.
- Load metadata during discovery and full instructions or resources only when a selected node reads
  their `skill://` URI.
- Treat `allowed-tools` as a permission request, never authorization; a package cannot widen the
  node's compiled Flow tools or broker policy.
- Record provenance, content digests, license, compatibility, metadata, requested tools, project
  trust state, selected identity, and exact observed reads.
- Preserve selected content in the provider-neutral `run_started` capability snapshot and detached
  job record so queueing, child execution, and resume never reload drifted live sources.
- Treat package code as inert resources. No script or extension is executed automatically.
- Prevent packages from directly changing transitions or evaluator definitions.

Pi's ambient skill discovery is disabled alongside its extensions, prompt templates, themes,
context files, and project discovery. This is intentional even though Pi can discover Agent Skills
natively: Flow's custom `flow_read`, durable snapshot, child-run, detached-worker, replay, and policy
contracts must remain identical across providers and future executor adapters. Pi receives only a
Flow-generated metadata catalog and resolves content through Flow-owned immutable sessions.

## Verifier packages

**Implemented for strict local and digest-pinned installed declarative command and model packages.** Flow discovers
`VERIFIER.yaml` below `.flow/verifiers`, validates an exact SemVer identity, and snapshots the exact
manifest only when a workflow selects its name and version. A command package contributes the
existing argv-only verifier command. A model package contributes only a bounded rubric; evidence,
provider/model selection, thinking, and timeout remain explicit workflow authority.

The implementation intentionally reuses neither Pi's in-process extension loader nor OMP custom
tools. Those mechanisms are useful for trusted interactive customization but can execute host code
with runtime-specific authority. Flow package directories contain only one inert manifest. Package
resolution feeds the existing sandboxed command or zero-tool model verifier, so it cannot bypass
the scheduler, policy, containment, evidence, or replay boundary. Prime Verifiers environments may
be integrated later behind an explicit adapter; they are not a core dependency or executable
package payload.

Package metadata, exact manifest bytes, definition, provenance, trust state, version, and nested
digests share the provider-neutral capability snapshot with Agent Skills. `run_started`, detached
jobs, child ledgers, and recovery carry that exact snapshot. Verdict evidence records name, version,
and digest; replay cross-checks that identity with the compiled control graph and persisted node
requirement. Listing, inspection, and validation invoke no verifier, and inspection omits a model
rubric.

Executable extensions and policy/UI package manifests remain later Gate 6 work. Evaluator
manifests are implemented only for the current command/model verifier
drivers; arbitrary evaluator code and reward environments remain out of scope.

## Command tool packages

**Implemented for strict local and digest-pinned installed declarative command tools.** Flow discovers `TOOL.yaml` below
`.flow/tools`, validates one exact SemVer identity and one closed scalar model-tool contract, and
snapshots the exact manifest only when a workflow selects its name and version. The v1 driver must
select a closed Flow-owned command profile. The initial `posix-printf-v1` and exact hardened
`git-status-v1` profiles bind `/usr/bin/printf` or `/usr/bin/git` plus data-only argument positions;
project packages cannot add shells, interpreters, dispatchers, alternate paths, or profiles. Inputs may
occupy only complete profile-approved data elements, so model values cannot become code or shell
structure.

Flow reuses Pi's typed custom-tool seam but not its extension or package loader. It does not import
OMP's mutable hook or middleware surface. The selected
definition is translated at the adapter boundary, while the rendered request enters Flow's
existing agent-command recorder. Policy, optional live approval, sandboxing, process lifecycle,
write-ahead evidence, cancellation, output bounds, budgets, and replay therefore remain Flow-owned
and provider-neutral.

Package metadata, exact manifest bytes, definition, requested permission, provenance, trust state,
version, and digest share the immutable capability snapshot with skills and verifiers. Each agent
has an exact compiled selection; `run_started` records that requirement with raw-`exec` eligibility,
and the control graph independently records whether raw `exec` and which packages were available.
Replay reconciles both. Detached jobs carry the bytes
unchanged, children bind only their own subset, and recovery refuses live-source substitution.
Sourced command events also record the exact tool name, typed input and digest, rendered argv, and
package identity so replay can derive rather than trust what should have executed.

This ABI is deliberately not a general plugin host. Packages cannot contribute JavaScript,
Python, Wasm, native payloads, hooks, providers, result middleware, graph nodes, credentials,
network grants, environment variables, or policy. Executable drivers remain future work behind a
separate containment contract.

## Workflow packages

**Implemented for strict local and digest-pinned installed inert workflow source.** Flow discovers
one `WORKFLOW.yaml` below each `.flow/workflows/<path>/<name>` package, validates exact SemVer identity and
bounded ordinary Flow workflow source, and executes no package code during discovery, inspection,
packing, or compilation. A root uses `workflow:<name>@<exact-version>`; a child uses an exact
`child.package` reference instead of embedding its source.

Admission discovers a bounded transitive package set, snapshots exact manifest bytes, provenance,
workflow hash, and package digest, then recompiles through the standard workflow compiler with a
closed immutable snapshot resolver. That second compile is authoritative. It preserves existing
graph, child isolation, budget, typed-result, approval, evidence, policy, sandbox, and recovery
semantics rather than creating a package scheduler. `run_started`, detached jobs, child ledgers,
and resume carry exact package requirements and reject live-catalog substitution.

Workflow packages are inert source capabilities, not Pi/OMP-style executable extensions. They
cannot register hooks, tools, drivers, providers, credentials, policies, sandbox profiles, or
dynamic graph factories. Exact source reuse is the initial ABI; parameters, version ranges,
dependency solving, compatibility negotiation, and policy/UI packages remain separate designs.

## Digest-pinned bundle distribution

**Implemented for the four existing inert package ABIs.** `flow packages pack` reads one strict
`BUNDLE.json` plus optional `skills/`, `verifiers/`, `tools/`, and `workflows/` source roots. It rejects unknown
top-level entries, symlinks, special files, unsafe paths, source races, and extra verifier, tool, or
workflow payloads, then emits canonical strict JSON with bounded canonical base64 content. There is no tar,
zip, dependency graph, executable extension, hook, or install script. Rebuilding the same source
produces the same bytes and SHA-256.

`flow packages install <https-url> --sha256 <hex>` is the only remote operation. The URL must be a
canonical public HTTPS URL without credentials, query, fragment, or redirect. Flow resolves all
addresses, rejects any non-public result, and pins one validated address into Node's TLS connection
while preserving hostname verification. It sends only fixed Accept and User-Agent headers, shares
one deadline across DNS/connection/body work, and stops at the bundle byte limit. Expected SHA-256
is checked over the exact response before UTF-8, strict JSON, or package parsing.

Validated bytes are published once at `.flow/packages/sha256/<hex>.flowpkg`. A deterministic
`.flow/packages.lock.json` entry is published last under a same-host owner lock; therefore a crash
may leave only an inactive orphan blob. Reinstallation of the same identity and bytes is
idempotent. A different digest for the same bundle identity, duplicate package name, duplicate
provider-facing tool name, missing/corrupt blob, or local/installed collision fails closed. List,
inspect, verify, and remove are local and invoke no package driver. Removal publishes the reduced
lock before best-effort orphan cleanup.

Mutation locks fail closed and are not retired automatically. If the recorded process has exited,
an operator must first verify that no package mutation is active, then remove only the exact
`.flow/packages.mutation.lock`. `commit_uncertain` means a replacement became visible or a mutation
completed but directory durability or lock cleanup could not be confirmed. Inspect the live lock,
run `flow packages verify`, and reconcile the requested exact versions before retrying.

There is no atomic upgrade command. Pause new admissions, retain the old source and digest, install
the new exact bundle version, remove the old exact version, verify, then resume. Overlapping package
or provider-facing tool names make catalog discovery fail closed while both versions are locked;
non-overlapping versions may coexist. Rollback explicitly reinstalls the retained old version and
removes the new one. Same-name/same-version bytes are immutable, and Flow performs no automatic
update discovery, rollback, or garbage collection.

Catalog composition reopens and rehashes every lock-selected blob, re-derives bundle/package
identities, and captures verified content in memory. Provenance has the portable form
`.flow/packages/sha256/<digest>/<kind>/<name>`; the recorded source URL is not run evidence or a
fetch instruction. Attached and detached admission snapshots exact selected content. Child runs,
workers, resume, and replay use only that durable snapshot and never consult the live lock, blob,
URL, DNS, or publisher.

This design adopts the [OCI descriptor](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
principle—verify expected digest and size before consuming content—without importing registry,
layer, authentication, or archive semantics. It intentionally does not reuse
[Pi's npm/Git package manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
because Pi packages may install dependencies and execute host extensions. A digest proves exact
bytes only. Publisher signing, freshness, expiry, rollback protection, revocation, transparency,
delegation, and automatic update discovery require a future
[TUF-like registry metadata layer](https://theupdateframework.github.io/specification/).

## Coupling rules

- No Pi, OMP, Prime Agent, or provider type appears in a persisted workflow or public Flow API.
- No domain module imports an executor or infrastructure implementation.
- No tool implementation advances a workflow.
- No model session writes authoritative run state.
- No package increases its own authority.
- No executor declares its output accepted.
- No retry repeats an unresolved consequential side effect.
- Only infrastructure adapters and composition code may import Pi, OMP, or sandbox-runtime packages.

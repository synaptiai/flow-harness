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
| Basic coding tools | Flow-owned workspace-confined `read`, `ls`, exclusive `create`, hash-anchored `edit`, and sandboxed argv-only `exec` definitions built on Pi's custom-tool interface | Pi's built-in edit and bash tools, fuzzy matching, direct writes, ambient path access, and helper-binary downloads are disabled; Flow owns policy, atomic creation and replacement, command/effect journals, containment, and evidence |
| Custom tool API | Present Flow broker tools to the model | Tool schemas remain Flow-owned |
| Context transformation and compaction | Reuse mechanics | Durable state remains outside context |
| Session usage statistics | Translate `getSessionStats()` after settlement | Persist only Flow token components and integer micro-USD; Pi totals and transcripts are not authoritative |
| Session storage | Optional diagnostic artifact | Never authoritative run state; fresh recovery deliberately creates a new in-memory session rather than reopening a Pi transcript |
| TUI primitives | First-party terminal renderer only | Flow owns the presentation document, safe text, navigation, actions, cursor replay, and terminal lifecycle |
| Browser primitives | Fixed first-party loopback host only | Flow owns the document, DOM projection, capability, browser context checks, actions, replay, and listener lifecycle |

Pi is MIT-licensed. Its fast release cadence and breaking changes create meaningful update risk, so Flow pins exact versions and maintains adapter conformance tests. See the [Pi repository](https://github.com/earendil-works/pi) and [agent-core documentation](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md).

The terminal adapter imports `@earendil-works/pi-tui` only from Flow infrastructure. Domain and
application modules do not import it. Flow does not use Pi Markdown, hyperlinks, clipboard, image,
URL-opening, or mouse features. The browser adapter uses fixed Flow HTML, CSS, and JavaScript. It
accepts no package resource or renderer. Flow discovers inert A2UI-profile presentation manifests
through a separate, explicit catalog. Those manifests can arrange only the closed Flow widget set
that both first-party hosts project. Catalog v2 can also supply bounded static note literals. The
manifests cannot supply actions, data bindings, functions, themes, links, assets, code, remote
resources, or dynamic children.

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
| Continual harness refinement | **Implemented independently for current surfaces** with bounded prompt, Agent Skill resource, Agent Skill package, model-route, child-specialist, and supplemental-memory candidates; paired complete-state evaluation; sequential reviewed composition; durable offline snapshots; and retained-state rollback. Model-written learning, live retrieval, and general delegation remain future work |
| Immutable base plus supplemental state | **Implemented for reviewed read-only supplemental memory** inside the complete effective harness state. Conversation state and writable memory remain outside Flow's authority model |

See [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), its [architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md), and its [RLM trust model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md). Prime Agent is MIT-licensed; substantial copied portions require preservation of both Pi and Prime notices.

Prime Agent shows the value of an immutable base with supplemental refinements. Flow narrows that
pattern. A prompt or Agent Skill resource candidate has no Python or runtime authority. It cannot
apply itself. It must bind the exact tuning evidence and baseline.

Agent Skill resource generation binds one exact package snapshot and an operator-selected allowlist
of existing UTF-8 resources. The allowlist excludes `SKILL.md` and the top-level `scripts/`
directory. The model receives no live catalog, unselected resource, package-selection authority,
tool, or workspace access.

Agent Skill package generation starts from a workflow that selects no Agent Skill. The operator
supplies one content-free blueprint that fixes the skill authority, one root agent target, and one
through sixteen exact paths. `SKILL.md` is required. Other files may be inert UTF-8 references or
textual assets. Flow rejects scripts, executable modes, links, special files, binary content, and
undeclared paths. One zero-tool model turn supplies only the declared file contents.

The review artifact is a private candidate directory with `CANDIDATE.json` and
`skill/<operator-selected-name>/`. It is not an installed package. Paired evaluation compares the
original workflow with no package against the projected workflow with the exact generated package.
Reviewed composition stores both complete states durably. A prompt improvement survives a later
Agent Skill change, and an Agent Skill improvement survives a later prompt change. Rollback selects
any retained complete state. Current policy remains outside the rollbackable state.
Generation does not sign, install, publish, distribute, or execute the candidate.

Supplemental memory is reviewed context, not a capability package. It has no registry, TUF,
Sigstore, installation, discovery, or live retrieval lifecycle. One candidate changes one bounded
entry for an existing agent in the complete effective harness state. An optional zero-tool model
turn can suggest the value for an operator-selected add or replacement, but it cannot select or
activate the target. Runs use the activated bytes from their immutable capability snapshots. For
the review and evaluation procedure, see
[Supplemental-memory candidates](evaluation.md#supplemental-memory-candidates).

Flow uses its standard compiler and paired evaluation gate. An operator can activate only a complete
superior evaluation. The effective store keeps immutable complete states, composed artifacts,
durable run snapshots, and rollback history. Flow does not import Prime's refiner, state format,
IPython kernel, or direct-apply
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

Executable extensions remain later Gate 6 work. Inert A2UI-profile presentation manifests are
implemented separately. Evaluator manifests are implemented only for the current command/model verifier
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
package identity so replay can derive rather than trust the expected execution.

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
dynamic graph factories. Policy packages use a separate inert narrowing contract. Exact source
reuse is the initial ABI. Parameters, version ranges, dependency solving, and compatibility
negotiation remain separate designs. Inert presentation packages use their own closed A2UI profile
and do not enter workflow capability snapshots.

## Presentation packages

**Implemented for exact local and digest-pinned installed inert manifests.** Flow reads one
`PRESENTATION.yaml` below `.flow/presentations/<name>` or the corresponding path in an installed
bundle. `flow presentations validate [<manifest-path>]`, `list`, and `inspect` perform no run,
model, package action, terminal, or browser mutation. `flow tui --presentation
<name>@<version>` and `flow web --presentation <name>@<version>` resolve one exact package before
supervisor startup and host creation.

The manifest uses the production A2UI v0.9.1 release. Each message uses the wire discriminator
`version: v0.9`. The manifest contains one `createSurface` for the fixed `flow-run` surface and one
`updateComponents` for one versioned Flow catalog. Catalog v1 arranges each host-owned widget
exactly once. The widgets cover run summary, graph progress, node table, resource facts, pending
approvals, and outcome notice.

Catalog v2 preserves that graph and requires one final direct `FlowPackageNotes` root child. It has
one to four direct literal `{title, body}` entries. Title, body, and aggregate limits are 128,
1,024, and 4,096 UTF-8 bytes. Safe display-text validation rejects controls, bidirectional
formatting, terminal escapes, unsafe Unicode, and line breaks.

Flow supplies every displayed fact and action from the
validated public presentation document. Optional widgets may disappear when the host has no
corresponding fact. The package cannot invent one. Flow projects valid notes into a fixed final
section. The section names the exact package and states that its text is not Flow status or an
action.

Catalog v1 rejects all package content. Catalog v2 accepts only the bounded note literals. Both
profiles reject model data, bindings, functions, actions, themes, inline catalogs, dynamic child
lists, links, assets, scripts, remote resources, and unknown components. The public catalog schemas
are [`specs/flow-a2ui-run-presentation-v1.catalog.json`](specs/flow-a2ui-run-presentation-v1.catalog.json)
and [`specs/flow-a2ui-run-presentation-v2.catalog.json`](specs/flow-a2ui-run-presentation-v2.catalog.json).
The schemas describe the A2UI custom catalogs. Flow's manifest validator narrows general A2UI child
lists to static component-id arrays.

Package selection is session-local. It is not workflow authority and is absent from durable run
state, capability snapshots, worker requests, child ledgers, and recovery identity. The default
presentation remains governed by the existing host projection when no package is selected. The
local Agent Client Protocol v1 adapter can carry the sanitized document and exact interaction to
an editor. ACP does not replace this package profile, browser API, durable run state, or
presentation authority. The editor cannot select package content through ACP.

## Digest-pinned bundle distribution

**Implemented for the six existing inert package ABIs.** `flow packages pack` reads one strict
`BUNDLE.json` plus optional `skills/`, `verifiers/`, `tools/`, `workflows/`, `policies/`, and
`presentations/` source roots. It rejects unknown top-level entries, links, special files, unsafe
paths, source races, and extra manifest payloads. It emits canonical strict JSON with bounded canonical base64 content. There is no tar,
zip, dependency graph, executable extension, hook, or install script. Rebuilding the same source
produces the same bytes and SHA-256.

`flow packages install <https-url> --sha256 <hex>` and `flow packages install-oci` are the only
package network operations. The HTTPS URL must be canonical and public, without credentials,
query, fragment, or redirect. Flow resolves all addresses, rejects any non-public result, and pins
one validated address into Node's TLS connection while preserving hostname verification. It sends
only fixed Accept and User-Agent headers, shares one deadline across DNS, connection, and body
work, and stops at the bundle byte limit. Expected SHA-256 is checked over the exact response
before UTF-8, strict JSON, or package parsing.

The `flow packages install-oci` command accepts only a canonical HTTPS registry host with public
pinned addresses. It also requires one repository and lowercase SHA-256 manifest digest. It rejects
a tag, version range, registry discovery result, or package-provided reference. It also rejects an
IP literal, port, query, or fragment before DNS. Private access adds `--username <exact>
--password-stdin`. These two options must appear together.

The manifest is a strict OCI image manifest with an empty config and exactly two ordered layers.
The first layer is one strict Flow bundle. The second is one Sigstore v0.3 message-signature bundle.
Flow requires exact response and manifest media types. It checks the manifest, layer sizes, and
layer digests before it parses or verifies content. Unknown fields, annotations, layers, and media
types reject.

The operator policy contains one canonical HTTPS certificate issuer and one exact certificate
identity. Flow escapes and anchors the identity before Sigstore verification. Verification uses the
public-good trusted root that ships in the Flow package. It requires the admitted certificate,
signed time, certificate-log evidence, and transparency-log inclusion evidence. It performs no
online trust-root, certificate-authority, transparency-log, or timestamp request.

Registry resolution, credential input, bearer challenge, token request, manifest read, redirect,
and layer read share one total deadline. The bearer challenge must contain one canonical HTTPS
realm, exact service, and exact `repository:<name>:pull` scope. Flow validates that challenge before
it invokes a private credential callback. Anonymous installation supplies no callback and reads no
secret input.

The authenticated registry response is the authority that selects the token realm and service.
Flow sends those exact challenge values in the token request. It cannot prove that a different
realm origin has the same operator as the registry origin. The operator must trust both origins
to use the private registry. For narrower credential scope, use a registry-specific credential.

Flow does not broaden this delegated authority
to redirects, artifact endpoints, configuration, or later execution. The returned Bearer token is
opaque. Flow cannot inspect its embedded grants. It confines that token to the original registry
and the exact digest-addressed manifest and layer reads.

The username contains 1 to 256 visible non-space ASCII characters and no colon. Password stdin
contains one non-empty UTF-8 record of at most 16,384 bytes. Flow removes one terminal LF. It
rejects NUL, CR, another LF, invalid UTF-8, empty input, and byte 16,385.

Flow sends one RFC 7617 Basic value only to the exact token realm. It requests no offline access.
It rejects refresh tokens, dual token fields, extra response fields, token redirects, and
non-success status. The bounded Bearer token is memory-only and goes only to the original registry.
A cross-host blob redirect receives neither authorization value.

Flow clears its mutable secret and Basic buffers after token settlement. JavaScript and TLS
implementations can create temporary string copies that Flow cannot overwrite. Flow does not read
Docker configuration, invoke a credential helper, accept a password argument or environment
credential, or retain a login session. Public output, fixed errors, package locks, snapshots, and
run evidence omit the username, realm, credential mode, password, Basic value, and Bearer token.

Redirect targets must use public HTTPS and a pinned public address. Manifest and token redirects
reject. Public errors use fixed stages. They contain no response body, token, registry path,
publisher value, or parser cause.

Validated bytes are published once at `.flow/packages/sha256/<hex>.flowpkg`. A deterministic
`.flow/packages.lock.json` entry is published last under a same-host owner lock; therefore a crash
may leave only an inactive orphan blob. Reinstallation of the same identity and bytes is
idempotent. A signed reinstall is idempotent only when its OCI source and publisher evidence are
also exact. A different digest or signed provenance for the same bundle identity fails closed.
Duplicate package names and provider-facing tool names also fail closed.

The same rule applies to a missing or corrupt blob and a local or installed collision. List,
inspect, verify, and remove are local and invoke no package driver. Removal publishes the reduced
lock before best-effort orphan cleanup.

Mutation locks fail closed and are not retired automatically. If the recorded process has exited,
an operator must first verify that no package mutation is active, then remove only the exact
`.flow/packages.mutation.lock`. `commit_uncertain` means an active package-lock replacement became
visible but its directory durability could not be confirmed. Inspect the exact package versions and
run `flow packages verify` before retrying. `settlement_uncertain` means the package operation and
mutation-lock cleanup did not both settle. Inspect the live mutation-lock owner and verify that its
process is inactive. Reconcile the requested exact package state, remove only the exact mutation
lock, and run `flow packages verify` before retrying.

An arbitrary HTTPS or OCI upgrade has no atomic command. Pause new admissions, retain the old source
and digest, install the new exact bundle version, remove the old exact version, verify, then resume.
Overlapping package or provider-facing tool names make catalog discovery fail closed while both
versions are locked.

A reviewed TUF candidate has a narrower atomic replacement path. It replaces one exact established
version only when the capability surface is unchanged. This surface includes the bundle name,
publisher, package identities, requested tools, and provider-facing tool names. The new outer
version must have higher semantic-version precedence. Policy packages reject. One current metadata
state must authorize both exact targets during the lock switch.

Flow publishes the new immutable blob and replaces one lock entry. Readers observe the complete old
or new lock. The old immutable blob remains available to readers that captured the prior lock.
Replacement reports `cleanup: retained`. Existing durable snapshots remain unchanged. An exact
repeat returns `already_current`.

Retired content remains inert until an operator invokes explicit maintenance. `flow packages
prune` scans the bounded content-addressed blob directory. It validates every entry and returns a
canonical plan digest, retired blob count, and logical byte total. It does not mutate the store.

`flow packages prune --apply --expected-plan-digest <sha256>` takes the ordinary package
mutation lock. It rebuilds the plan and unlinks only the exact reviewed candidates. An active-lock
change returns `plan_mismatch` before the first unlink. A candidate-set change returns the same
fixed error.

The ordinary physical store ceiling is 256 blobs and 128 MiB. Installation and replacement inspect
the complete physical store and refuse a publication that would cross either ceiling. Maintenance
uses a larger recovery-only scan ceiling of 512 blobs and 256 MiB. This larger ceiling permits
bounded repair. It does not permit new publication above the ordinary ceiling.

The scan accepts
only canonical digest filenames whose bytes reproduce that digest. Every blob must be a bounded,
single-link regular file. Missing active blobs, links, special files, unexpected names, excess
entries, excess bytes, and inconsistent content fail closed.

Readers first capture one active lock and open every selected blob without following links. The
open file handles pin that generation while the reader validates and parses it. POSIX unlink
therefore cannot truncate an in-progress reader. If a retired path disappears before a reader can
open it and the active lock changed, the reader retries once from the new complete generation. An
unchanged lock with a missing blob is corruption.

Durable runs, workers, children, evaluations, recovery, and replay use package bytes already stored
in their immutable snapshots. Those snapshots are not garbage-collection roots.

Before the first unlink, cancellation returns the exact caller reason without mutation. After an
unlink, Flow ignores later cancellation until it syncs the blob directory, then restores the exact
caller reason. A later candidate failure also settles earlier progress. Repeating maintenance is
safe because a new preview contains only remaining retired blobs. `settlement_uncertain` means an
unlink occurred but directory durability could not be confirmed. Follow the package-maintenance
procedure in [Recovery and interruption safety](recovery.md#recover-retired-package-maintenance).

Rollback remains a reviewed forward replacement or the paused manual procedure. Same-name and
same-version bytes remain immutable. Flow performs no automatic update discovery, rollback, or
background garbage collection.

An operator may explicitly establish signed project metadata with `flow packages metadata refresh
<metadata.json> --sigstore-bundle <bundle.json> --certificate-issuer <https-url>
--certificate-identity <exact>`. The command reads only those bounded local files and reuses the
offline Sigstore verifier. It performs no discovery, download, trust-root refresh, or automatic
package action. The canonical metadata binds a monotonically increasing version, UTC expiry, and a
strictly sorted target list. Each target binds name, exact version, digest, bytes, source, status,
and any OCI publisher policy.

The first accepted metadata state makes this freshness layer authoritative for that project. Lower
versions and equal-version substitutions reject. Install and catalog admission require current
metadata plus one exact active target. An invalid local clock or `now >= expiresAt` rejects. List,
metadata inspection, exact-byte package inspection, and explicit package removal remain available
for remediation.

An authenticated empty target list is an established deny-all state for every new installation and
catalog admission. It does not restore the pre-metadata behavior. The state and package lock share
one mutation owner and publish through separate atomic replacements. A post-rename durability
failure is `commit_uncertain` and requires inspection.

Approach C adds an explicit signed channel without granting that channel activation authority:

```sh
flow packages metadata check <canonical-public-https-url> \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages metadata candidates list
flow packages metadata candidate inspect sha256:<digest>
flow packages metadata activate sha256:<digest> \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages metadata candidate remove sha256:<digest>
```

The check command follows no redirect and sends no credential. All resolved addresses must be
public, and the request is pinned to one admitted address under one total deadline. The response
must be HTTP 200 with exact media type
`application/vnd.synapti.flow-capability-metadata-envelope+json`. Its strict canonical JSON has
only `apiVersion`, `kind`, `metadataBase64`, and `sigstoreBundleBase64`. Canonical padded
base64 decodes to at most 524,288 metadata bytes and 1,048,576 Sigstore bundle bytes. The complete
canonical envelope is at most 2,097,285 UTF-8 bytes.

The envelope is transport evidence, not trust. Flow verifies the exact decoded metadata bytes with
the offline trusted root and the command-line issuer and identity. It then compares the verified
metadata only with active rollback authority. A successful check publishes or reuses one inert
content-addressed candidate and atomically replaces the latest-check observation. A channel URL,
check time, and envelope digest are observations. They do not change candidate identity.

Candidate identity binds the complete metadata summary and target list, exact metadata and
signature-bundle byte counts and SHA-256 digests, and exact signer policy. Candidate bytes are
reopened, bounded, parsed, and rehashed on inspection and activation. At most four distinct
candidates may coexist. Candidates do not create a monotonic high-water mark over each other, so a
staged high-version candidate cannot block a different later candidate. Only active metadata is
rollback authority.

Candidate-store commands use `.flow/packages.metadata.check.lock` as a fail-closed single-writer
boundary. Flow never reclaims an existing lock by guessing process liveness. An operator may remove
that exact file only after confirming that no metadata check, list, inspect, activation, or removal
operation owns it. Flow never traverses or deletes unexpected pending state. After the same
ownership check, an operator may inspect and remove only
`.flow/.packages.metadata.candidate.pending` or `.flow/.packages.metadata.check.pending`.
Candidate-store commands fail closed while either path exists.

Activation requires the exact candidate digest and newly supplied signer arguments. It reopens the
stored bytes, repeats canonical parsing, signature verification, freshness at a fresh clock
instant, and candidate identity reconstruction. It repeats active monotonic comparison before it
publishes active metadata. The candidate remains available after activation. Candidate removal
affects only that inert directory. Check, activation, and removal never mutate installed packages.

Catalog composition reopens and rehashes every lock-selected blob, re-derives bundle/package
identities, and captures verified content in memory. Provenance has the portable form
`.flow/packages/sha256/<digest>/<kind>/<name>`; the recorded source URL is not run evidence or a
fetch instruction. A signed lock entry also records the canonical registry reference, manifest
digest, exact publisher policy, and signature-layer digest for admission audit. This record is not
a fetch instruction. Attached and detached admission snapshots exact selected content. Child runs,
workers, resume, and replay use only that durable snapshot and never consult the live lock, blob,
URL, registry, DNS, signature service, or publisher.

This design uses the [OCI descriptor](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
principle: verify expected digest and size before consuming content. It supports only the fixed
Flow artifact contract and exact anonymous or challenge-scoped private pulls. It intentionally does not reuse
[Pi's npm/Git package manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
because Pi packages may install dependencies and execute host extensions. A digest proves exact
bytes only. The Sigstore bundle authenticates the admitted publisher for those exact bytes. It does
not prove package safety or correctness.

The opt-in signed metadata layer adds project-local expiry, revocation, exact-target admission,
monotonic rollback refusal, and explicit signed-channel discovery with inert review staging. It
relies on the local clock and explicit operator activation.

## Standards-based capability repositories

An operator can initialize one repository from an explicit local trusted-root file and one
canonical public HTTPS base:

```sh
flow packages repository init https://updates.example.test/ \
  --trusted-root ./root.json
flow packages repository status
flow packages repository check
flow packages repository candidates list
flow packages repository candidate inspect sha256:<digest>
flow packages repository candidate activate sha256:<digest> \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages repository candidate replace sha256:<digest> \
  --from-version <exact-current-version> \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages repository first-activate <bundle-name> \
  --version <exact-version> \
  --max-checks <1..1000> \
  --interval-ms 3600000 \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages repository watch <installed-bundle-name> \
  --interval-ms 3600000 \
  --certificate-issuer <exact-https-issuer> \
  --certificate-identity <exact>
flow packages repository candidate remove sha256:<digest>
```

Flow uses `tuf-js` 6.0.0 for the
[TUF specification](https://theupdateframework.github.io/specification/) workflow. This workflow
covers root, timestamp, snapshot, targets, and delegated-target roles. The client runs only in a
disposable private directory through Flow's strict public HTTPS fetcher. Flow disables retries and
bounds every role and response. It requires consistent
snapshots and reopens all staged files without following links. Flow then translates verified
evidence into its own immutable generation and candidate records.

The fixed logical index target is `flow/capability-index.json`. Each selected target is a strict
signed capability-bundle envelope. TUF authorizes the exact repository target bytes. Offline
Sigstore verification authenticates the exact publisher. Current Flow metadata decides whether
the exact package may be installed. None of those layers substitutes for another.

The portable index format permits at most 64 sorted unique entries. This Flow client stages at most
four selected candidates per check. A larger selection fails immediately after index
authentication and before package target downloads.

A successful check atomically advances repository freshness and stages at most four inert
content-addressed candidates. It does not change active metadata, installed packages, workflows,
policies, runs, or evaluations. Activation reopens and authenticates the complete generation
without network access. It requires a newly supplied exact publisher policy and repeats Sigstore
verification. It delegates the only package mutation to the ordinary package store.

Replacement performs the same offline generation replay and Sigstore verification as activation.
The package store reopens the established blob and requires publisher continuity. Current metadata
must authorize both targets before the store replaces one active lock entry. A known
pre-rename failure preserves the old generation. A post-rename durability failure is
`commit_uncertain`. The settled result reports retained old content.

Candidate removal creates a new repository generation. It does not remove an installed package.

The finite first-activation command is the only automatic first-install boundary. It binds one
exact missing bundle name, exact version, and exact publisher. It requires an explicit local TUF
root and a full interval before every check. The limit is 1 to 1000 checks. The command requires
offline Sigstore verification, an inert non-policy bundle, and one current active metadata target.

It records a waiting intent before scheduling and a prepared receipt before package mutation. Under
the package mutation lock, strict installation rejects another active version with the same name.
It checks the prepared clock high-water. It reopens the exact repository candidate before inert
blob publication and active-lock publication. It records a settled receipt after an exact installed
package is visible.

Settlement reuses the prepared high-water. It does not depend on a later clock read after package
commit.

The command then terminates. The
settled receipt cannot authorize an update or reinstall after removal.

An optional application scheduler can request checks at a bounded interval. It waits one full
interval after each settled check. It never overlaps or catches up missed checks. The scheduler
exposes only fixed status records and stops on clock rollback.

Startup and an optional prior completion expose restart gaps. Status records include
missed-interval and consecutive-failure counters. Delayed work and prolonged outages are visible
without catch-up retries. The scheduler has no activation port.

The optional foreground watcher composes that scheduler with the ordinary checker and replacement
operation. It binds one installed bundle and exact publisher. Patch-only is the default automatic
policy. An explicit `minor` policy permits same-major updates. The watcher selects the highest
admissible candidate. It never installs a first version or accepts a major update.

A check failure
can continue only after a new full interval. Any replacement failure or commit uncertainty stops.

One bounded project-local owner record prevents overlapping Flow watcher and first-activation
processes. The record is
cooperative local coordination, not same-user isolation. Flow never guesses that it is stale and
never removes it automatically. Retired blobs remain available until an operator applies an exact
prune plan. A frozen reader that opened one remains valid after its path is unlinked.

Private repository credentials, credential helpers, and online root bootstrap remain outside this
contract. The same is true for major or policy-package replacement, automatic rollback,
background blob collection, and online Sigstore trust-root refresh. ACP,
AG-UI, and A2UI are separate transport or presentation standards and do not change repository,
package, runtime, or activation authority.

## Coupling rules

- No Pi, OMP, Prime Agent, or provider type appears in a persisted workflow or public Flow API.
- No application module imports an infrastructure implementation.
- No domain module imports an executor or infrastructure implementation.
- No tool implementation advances a workflow.
- No model session writes authoritative run state.
- No package increases its own authority.
- No executor declares its output accepted.
- No retry repeats an unresolved consequential side effect.
- Only infrastructure adapters and composition code may import Pi, OMP, or sandbox-runtime packages.

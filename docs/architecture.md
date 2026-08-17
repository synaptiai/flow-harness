# Architecture

## Context

Flow turns a collection of useful software-development practices into an enforceable harness. The previous plugin described workflows through Markdown commands, skills, YAML metadata, and host hooks. Claude Code still owned the actual agent loop, scheduling, tool semantics, context, and session lifecycle.

The standalone harness reverses that relationship. Flow owns workflow execution and delegates only bounded node work to an embedded agent runtime.

This document describes the target architecture unless a section is explicitly labeled as the
current executable slice. The delivery roadmap is the source of truth for implementation status.
Gates 1 and 2 provide compiled graphs, evidence-based completion, bounded Pi agent nodes,
cancellation, and replayable local ledgers. Gate 3 adds the Flow policy broker, hash-anchored edits,
argv-only agent commands, fail-closed native command containment, exact deterministic-command
approval, and exact per-call approval for live agent `exec` tools. Gate 4 adds committed-boundary
recovery, exclusive local ownership, typed edit reconciliation, proof-safe fresh agent attempts,
durable budgets, detachable waits, and bounded authenticated local supervision. Gate 5 adds typed
results and verifiers, replay-safe conditions, joins, concurrency, bounded loops and optimization,
evidence-bound graph approvals, isolated child workflows, and candidate promotion. Gate 6 adds
strict local and exact installed Agent Skills, versioned verifier packages, and declarative command
tool packages. It also adds inert workflow packages and deterministic bundle distribution. Exact
publisher-authenticated OCI acquisition, a content-addressed project store, and immutable snapshots
are included.

Flow includes first-party terminal and local browser presentation hosts over the public run
projection. A strict A2UI v0.9.1 profile lets an exact inert package arrange the closed host-owned
widget catalog for one session. Executable or remote UI extensions and automatic package
activation remain later work.
Explicit signed capability metadata provides project-local freshness and revocation. One explicit
public HTTPS check can stage inert signed candidates for review, while activation remains a
separate explicit command. A standards-based TUF repository can now select exact signed package
envelopes through threshold roles, sequential root rotation, freshness metadata, consistent
snapshots, and bounded delegations. The operator supplies the initial root locally. Flow contains
the standard client in disposable staging, reopens its output, repeats package and Sigstore
verification, and publishes only inert Flow-owned candidates. Private repositories, online root
bootstrap, and automatic activation remain later work.
Opaque Pi session continuation and general failure or fallback
retries also remain later work. The same is true for broader configurable policy, model network
tools, and arbitrary evaluator runtimes. Stronger VM or managed sandbox backends also remain later
work.

## Target flows

Architecture is derived from these flows.

### User flows

| Flow | Trigger | Outcome |
| --- | --- | --- |
| Initialize | A user runs `flow init` in a repository | Validated project configuration and provider readiness |
| Execute | A user selects a goal and workflow | Verified success, explicit failure, a durable wait state, or a precise blocker |
| Observe | A user opens status, the TUI, or the local browser host | Current graph position, attempts, evidence, costs, approvals, and blockers |
| Steer | A user pauses, cancels, supplies input, or approves an operation | A durable, attributable state transition |
| Resume | A user reopens an interrupted run | Reconciled state and continuation from the next safe node |
| Extend | A user installs a capability package | Validated and explicitly enabled skills, tools, workflows, evaluators, or policies |
| Distribute | A publisher packs inert capability sources and an operator installs exact HTTPS bytes | Reproducible bundle identity, reviewable lock state, and no runtime/provider lock-in |
| Discover metadata | An operator or external scheduler invokes one explicit signed-channel check | One authenticated inert candidate and a bounded latest-check observation; no package or active-policy mutation |
| Activate metadata | An operator reviews and activates one exact candidate | Reverified monotonic active metadata for future admission; installed packages and existing run snapshots stay unchanged |
| Discover repository packages | An operator initializes an explicit trusted root and invokes a repository check | One atomically committed verified repository generation plus bounded inert candidates; no package installation or activation |
| Activate a repository candidate | An operator supplies one exact candidate digest and publisher policy | Offline TUF replay, repeated Sigstore verification, and one ordinary package-store installation under active metadata authority |

### Operator flows

- Configure credentials, model routing, budgets, policy, sandboxing, and concurrency.
- Inspect and recover crashed, blocked, rate-limited, or abandoned runs.
- Audit actions and export an evidence bundle.
- Approve an exact consequential action with a target, arguments, scope, and expiry.
- Benchmark model and routing profiles on held-out workflows.

### Target system flow

```mermaid
flowchart TD
    trigger["User, CI, or scheduled trigger"] --> compiler["Workflow compiler"]
    compiler --> graph["Typed executable graph"]
    graph --> scheduler["Deterministic scheduler"]
    scheduler --> context["Minimal node context"]
    context --> executor["Agent executor"]
    executor --> pi["Pi AgentSession"]
    pi --> provider["Selected model provider"]
    pi --> broker["Flow tool broker"]
    broker --> policy["Policy, approval, and sandbox"]
    policy --> environment["Repository, shell, Git, browser, and APIs"]
    executor --> evidence["Structured result and evidence"]
    environment --> evidence
    evidence --> verifier["Independent verifier"]
    verifier --> ledger["Append-only event ledger"]
    ledger --> scheduler
    scheduler --> terminal["Succeeded, failed, exhausted, blocked, cancelled, or waiting"]
```

The system contains two loops:

1. The inner agent loop lets a model use allowed tools to solve one bounded node.
2. The outer Flow loop decides readiness, transitions, retries, joins, approvals, evaluation, and termination.

The inner loop may propose a transition. It cannot authorize one.

## Components and dependency direction

```text
CLI / presentation hosts
        |
        v
local supervisor ------> detached worker
        |                       |
        v                       v
flow-application ------> flow-domain
        |                    ^
        v                    |
runtime-pi             store-local / tools-* / adapters-*
```

### Flow domain

Owns workflow and goal contracts, graph rules, lifecycle state machines, exact condition, join,
bounded-loop, accept-best optimization, and typed-result contracts, omission state, evidence contracts, policy decisions,
approvals, budgets, and failure classifications. It imports no Pi, OMP, Prime Agent, provider, UI,
filesystem, or database types. Child contracts contain only provider-neutral workflow, run-link,
workspace-provenance, typed-result, and resource projections.

### Flow application

Compiles workflows, including finite expansion of bounded loop bodies and optimization candidates, selects the next legal
executable or control transition, assembles minimal context, calls domain ports, evaluates results,
and records transitions. It binds model verifiers and typed results to exact complete durable source
attempts. It recursively schedules independently-ledgered child workflows through an isolation
port, reserves their ceilings against ancestors, and imports only typed results and resource
evidence. A candidate-workspace port captures and promotes typed deltas behind durable lifecycle
callbacks. Application modules import domain contracts and application-owned ports, not
infrastructure implementations. The same state-based selector checks recovered history. It never
executes tools directly. Result, condition, join, loop-check, optimization-check, and controller
nodes never enter an executor port.

### Presentation hosts

`flow tui <run-id> --actor <label>` follows the same bounded supervisor event pages as `flow
events`. The application reduces each page with the authoritative run reducer and projects only a
strict public `FlowPresentationDocument`. The document has a closed component and action grammar.
It is not durable state and cannot select a workflow, tool, provider, file, or policy.

All non-Flow display values become terminal-safe text before the infrastructure renderer receives
them. The Pi terminal package supplies alternate-screen, input, and layout primitives only. It does
not parse source data, sanitize text, retain run history, or route actions. Flow disables mouse and
does not use Markdown, hyperlinks, clipboard controls, images, or URL opening. The renderer adds
only Flow-owned ANSI styling after strict document validation.

An optional presentation package is resolved before supervisor startup, terminal takeover, or
browser listener creation. Its
A2UI messages select the fixed `flow-run` surface and Flow catalog, then arrange the six opaque
host widgets. The projector never reads package-provided display content because the profile has no
content, binding, function, theme, action, asset, or dynamic-child fields. Selection is not durable
run authority and does not enter replay.

`flow web <run-id> --actor <label>` serves the same document from one explicit IPv4 loopback
listener on an ephemeral port. A 256-bit session capability enters the initial URL fragment. The
fixed client moves it to tab-scoped `sessionStorage`, removes the fragment, authenticates a bounded
streaming fetch, and renders with DOM node creation and text insertion. Tab storage supports reload
and can follow browser session restoration. A related browser context can receive an initial copy,
but the fixed client never opens one. Terminal observation removes the capability, which never
enters a cookie, `localStorage`, a request URL, or durable Flow state.

Exact host, origin, Fetch Metadata, bearer, header, body, JSON, observer, write, and reconnect checks
precede data or action authority. Static HTML, CSS, and JavaScript are fixed first-party constants.
The host provides no CORS, cookie, service worker, external resource, package code, package content,
raw event, remote listener, or proxy mode.

Browser actions carry the latest positive document sequence and one opaque action id. The existing
application controller rebinds both before the approval or cancellation boundary. Only a settled
action is consumed. An uncertain failed attempt can be retried and is revalidated.

Browser close or reload ends observation, not the run. One bounded latest complete document supports reload. A
terminal document has a bounded delivery rendezvous before listener cleanup.

The loopback capability is not an isolation boundary against a malicious same-UID process. A
local ACP v1 stdio adapter can carry the already-sanitized presentation and exact input actions to
an editor. Its durable session descriptor binds one ACP session id to the same Flow run id,
canonical project, admitted policy digest, and actor. The supervisor command and run ledger bind
the selected workflow after `/flow-run`. Load and replay use those durable records.

The ACP adapter accepts only its two Flow commands, project-confined workflow sources, and the
implemented standard session methods. It does not consume editor filesystem, terminal, MCP, or
extension authority. Its strict byte and protocol streams bound frames, JSON structure, active
requests, cancellation-notification work, permission waits, output ordering, and cleanup. The
bridge captures one policy configuration for its lifetime. It reconciles the bounded gap between
supervisor acceptance and the first ledger event without resubmitting work. ACP remains a transport
boundary rather than the package ABI, browser API, supervisor protocol, or durable event model.

An approval, denial, or cancellation keypress carries one current opaque action id. The application
rebinds that id to the latest validated document and invokes the existing approval or supervisor
cancellation boundary. The renderer never writes a ledger or supervisor record. A stable command
UUID identifies cancellation settlement. Non-interactive use fails before configuration,
supervisor startup, storage access, or terminal takeover. JSON `inspect`, `events`, `approve`,
`deny`, and `cancel` remain the automation and recovery interfaces.

### Pi runtime

Implements one Flow-owned `AgentExecutor` port. It creates node-scoped in-memory sessions, selects
models and tools, streams events, supports cancellation, supplies an attempt-scoped Flow policy
broker, and translates Pi values into Flow contracts. The optional `flow_exec` tool delegates exact
argv requests to the production SRT executor used by command nodes. A compiled
`toolApproval.exec` declaration inserts a provider-neutral live promise gate between policy
allowance and durable command preparation. The application writes the exact request, waits on a
decision-source port, validates run/workflow/node/attempt/cwd/argv/timeout/digest identity, and lets
the sole run owner append the decision. The port distinguishes invalid input from transient
unavailability: the application audits the former and retries the latter with bounded abortable
backoff under the node signal. Denial returns a bounded tool error to Pi; grant consumption and
command preparation are one reducer transition. A run-scoped queue serializes pending human
decisions across concurrent agent nodes, while already granted commands remain free to prepare.

Linux preparation resolves a canonical root-owned Bubblewrap executable outside the workspace,
configures SRT with that absolute path, and accepts only SRT's canonical outer-shell descriptor with
the same executable and position-checked secure lifecycle tail. Flow rejects unknown options;
process-group-only macOS preparation is released and denied. The deadline covers sandbox
preparation and is checked again at spawn. Unconfirmed descendant termination is attempt-fatal:
the command settles durably, later command preparations are denied, Pi is aborted, and terminal
success is rejected. Flow disables Pi assistant-turn and provider retry layers; the adapter executes
one Flow attempt, while durable Flow policy alone can authorize a later fresh attempt.

### Portable Agent Skills

The infrastructure scanner discovers strict local Agent Skills metadata below `.flow/skills`, but
the workflow—not discovery—selects capability. Before admission the application collects root and
child selections and creates one bounded immutable capability snapshot containing canonical
metadata, exact file bytes, provenance, trust state, permission requests, and nested SHA-256
identities. The `run_started` event is the replay boundary; attached execution, the detached job,
child ledgers, and recovery receive that same content identity rather than reopening mutable package
paths.

Pi's ambient skill discovery remains disabled. The adapter injects a metadata-only catalog into the
locked Flow system prompt and routes `skill://` reads through a snapshot-backed session inside the
Flow-owned `flow_read` tool. The session checks node selection and resource identity but never adds
workspace, execute, network, or policy authority. Agent evidence projects selected package digests
and exact observed resource reads back into the provider-neutral ledger. Domain replay validates
receipts against frozen bytes; workflow recovery additionally validates each selection against the
compiled node. A future non-Pi executor can implement the same contract without changing workflow
or history formats.

### Versioned verifier packages

The verifier catalog discovers strict local `VERIFIER.yaml` manifests below `.flow/verifiers`.
Each package declares an exact SemVer identity and either an argv-only command definition or a
bounded model rubric. Directories may contain only that inert manifest: symbolic links, executable
resources, unknown fields, duplicate names, source races, and package or aggregate bound failures
reject admission. Metadata operations validate identity and provenance without invoking a driver;
inspection omits the model rubric.

The workflow selects an exact package tuple with `packaged-command` or `packaged-model`. A command
package owns the existing command declaration. A model package owns only the rubric, while the
workflow retains evidence order, provider/model choice, thinking level, and timeout. The compiler
preserves that reference in its digest and control graph. Before admission, application composition
collects root and child references and adds their exact manifest bytes and parsed definitions to
the same tagged immutable capability snapshot used by Agent Skills.

Immediately before execution, the scheduler resolves the selected definition from the frozen
snapshot into the ordinary inline verifier shape. The existing verifier executor therefore retains
command containment, zero-tool model isolation, input bounds, cancellation, and verdict semantics.
It records package name, version, and digest on typed verifier evidence. `run_started` separately
persists each node requirement; domain replay reconciles requirement, snapshot, control graph, and
evidence without consulting the live catalog or provider. Detached jobs transport the snapshot
unchanged, child ledgers use their declared subset, and recovery refuses any caller replacement.

This is a declarative package boundary, not a general plugin host. Packages cannot execute hooks,
register tools, add credentials or network, mutate policy or graph structure, select a model, or
import Prime Verifiers environments. Digest-pinned remote distribution of this inert ABI uses the
separate installation boundary described below. Future executable package sources require a
separate out-of-process authority and containment design.

### Versioned command tool packages

The command tool package catalog discovers `.flow/tools/**/TOOL.yaml` as inert project data. A
package declares one exact SemVer identity, one provider-safe tool name, required scalar inputs, a
closed Flow-owned command-driver profile with an argv-only template, and only the
`process.execute` permission. Its directory may
contain no executable payload or extra resource. The no-follow scanner rejects symbolic links,
special files, duplicate identities, source races, unknown fields, unsupported driver versions,
partial input interpolation, and bounded-size overflow.

Profiles are the admission boundary between data and code. The initial registry contains only
`posix-printf-v1`, which binds `/usr/bin/printf` and whose fixed format may use `%%` and `%s` data
conversions, and `git-status-v1`, which binds `/usr/bin/git` plus one exact hardened vector. Project
packages cannot register executable identities or profiles, and shells, interpreters, dispatchers,
alternate paths, and unsupported argument roles fail before tool registration. The system paths are
part of Flow's host trust base; this is not binary signing or remote attestation. Profile definitions
and the live agent-command byte/timeout envelope are checked while parsing the manifest, not deferred
until the model calls the tool.

Before admission, composition collects every root and child selection and adds the exact manifest
bytes, parsed definition, trust/provenance metadata, and nested digests to the immutable capability
snapshot. A command tool package is visible only on the agent that selects its exact name and
version; duplicate model names and collisions with Flow tools fail the complete workflow. Pi is an
adapter at this seam: Flow translates the provider-neutral definition into one custom Pi tool while
keeping Pi extensions and package loading disabled.

When the model calls the tool, Flow validates its closed scalar input object and renders each input
as one literal argv element. It then annotates the ordinary normalized agent-command request with
package, tool, input, and digest provenance. The existing recorder remains the sole authority for
policy, live approval, sandboxing, write-ahead prepare/settle events, cancellation, output bounds,
and budget accounting. Replay independently rerenders the command from durable inputs and the
snapshot, then reconciles the workflow selection, an independent raw-exec/package requirement, the
control graph, request, decision, approval, and settlement. Detached workers transport the snapshot unchanged, child ledgers bind only their
declared subset, and recovery never consults the live catalog.

This is intentionally narrower than Pi or OMP in-process extensions and Prime-style Python skills.
Package code cannot enter the host runtime, intercept results, add hooks, mutate the graph, select a
provider, or widen policy. Digest-pinned remote acquisition has its own transport and installation
trust boundary. Future executable drivers require a separate out-of-process containment design.

### Versioned workflow packages

The workflow package catalog treats `.flow/workflows/**/WORKFLOW.yaml` as inert source data with an
exact SemVer identity. A root locator or child reference selects an exact package; admission
discovers the bounded transitive set and then performs the authoritative compile through a closed
immutable snapshot and the standard workflow compiler. No filesystem, bundle lock, URL, provider,
or package hook is available to that final resolver.

Compiled packaged workflows retain `{name, version, digest}` provenance. Capability binding,
`run_started` requirements, the projected control graph, detached job digests, child ledgers, and
recovery reconcile that identity with the exact manifest and embedded workflow hashes. Inline roots
and embedded children retain their existing structures and digests because provenance is absent
unless a package was explicitly selected.

This is composition, not a second runtime. Package source remains subject to the ordinary compiler,
scheduler, budgets, approvals, child isolation, policy, containment, evidence, and replay rules.
Packages cannot load executable modules, register hooks or tools, choose providers, add credentials,
or widen policy. Policy packages use a separate inert narrowing contract. Parameterized templates,
compatibility solving, and executable UI extensions require separate public contracts. The inert
A2UI-profile terminal package has its own closed contract.

### Tool broker

The current broker normalizes and canonically resolves every model-requested `read`, `ls`, and `edit` filesystem operation and every argv-only `exec` request, derives its authority class, authorizes only declared operations, and emits bounded decisions tied to the exact run/node attempt. A directory listing is one logical authorization even when it returns many bounded entries. Edit authorization binds a digest of the complete model request. For writable attempts, the application supplies a narrow provider-neutral effect journal. The editor durably records the canonical target, operation digest, before/after SHA-256 values, and permission mode before rename while holding the target lock, then durably settles the effect after the commit boundary while journal publication remains available. A rejected settlement append poisons the journal and leaves the prepared effect unresolved. During recovery, a separate provider-neutral reconciler observes only an open typed edit and publishes through an application-owned callback while the same target lock remains held. It rejects non-regular targets before open and hashes only the initially observed size through bounded chunks. When missing ancestry makes the sibling lock impossible, it may publish only a rechecked `target_missing` observation under the in-process target queue; any observable target is refused. Replay matches every prepared effect, including not-applied effects, to a distinct allowed write decision. Terminal receipts are exact projections of executor-settled committed or unknown effects and must agree with their effect events; recovery observations never become terminal receipts.

For `exec`, the broker binds `process.execute` authorization to the normalized executable, literal arguments, and deadline. The application appends `node_agent_command_prepared` before the shared sandbox executor can spawn, then appends `node_agent_command_settled` with the complete bounded command outcome. Settlement charges retained stdout/stderr immediately, including when the outer agent turn is later interrupted, and terminal agent evidence does not charge it again. Open commands block terminal publication and recovery; arbitrary execution is never treated as proof-safe read-only work. The domain contract distinguishes read, write, execute, network, credential, and destructive authority without importing runtime types. Dynamic model-tool approval, configurable profiles, and network tools remain subsequent Gate 3 slices. Tool implementations cannot select or advance graph nodes.

### Command sandbox

Every command executor depends on a Flow-owned `CommandSandbox` port. The built-in operator profile
is `native`. Its production composition uses Anthropic Sandbox Runtime (SRT) with a fixed, versioned
profile. Workspace and private temporary writes are allowed. Network, home-directory reads, ambient
credentials, run-store writes, and writes to sensitive project state are denied.

Sandbox dependency errors and degraded-security warnings fail before spawn. Same-policy concurrent commands share one
process-global SRT session. Each wrap receives its own private temporary directory and complete
per-exec filesystem configuration.

A reference-counted Flow coordinator serializes initialization and teardown. It queues an
incompatible workspace or policy until the active session resets. It
invokes SRT's per-command cleanup once per wrap, honors cancellation while queued, and resets only
after the final compatible command releases. Cleanup must complete before a node can succeed.

A trusted operator can select `container` on Linux x64. The composition then uses one Docker
container per command under the fixed `flow-container-v1` policy. It projects the runtime, image,
socket, executable, seccomp, and policy identity from the prepared Prime OCI attestation. It checks
currentness before create and again immediately before launch. The application still supplies one
backend-neutral preparation request and receives one immutable execution and release contract.

The Docker adapter preserves the exact executable and ordered argument vector as the container
entrypoint and command. It does not add a shell. It submits one read-write workspace bind and only
explicit read-only runtime support binds. It uses a read-only root, private cgroup namespace, no task
network, and no IPC. It adds no capability and sets no new privileges. It uses fixed seccomp,
bounded temporary storage, and fixed resource limits.

The prepared command exposes a provider-neutral managed execution operation. The Docker adapter
attaches to standard output and standard error before it starts the verified full container ID. It
then starts through API 1.51 and waits for the not-running state. The command deadline signal owns
that long wait. The ordinary short Docker-query timer does not replace it.

The adapter decodes each bounded non-TTY multiplex frame. It forwards only task bytes to the
executor's cumulative bounded capture. Attach, start, wait, stream, and attachment-release faults
map to closed stages. The legacy launch descriptor remains inert compatibility metadata while
managed execution is present.

An attach failure is before start and has no command side effects. Later control failures may occur
after task execution begins. They retain bounded task evidence and report uncertain side effects.
Confirmed container absence proves termination, but it does not reverse workspace mutation.

The fixed process ceiling is the container cgroup `pids.max` value. The adapter does not submit an
`nproc` rlimit. The command runs with the trusted host operator UID so that the workspace bind stays
writable. Linux accounts `RLIMIT_NPROC` across that UID outside the container PID namespace, which
would couple command availability to unrelated host processes instead of bounding this container.

The command-only seccomp profile derives from the admitted Prime profile. It removes socket
creation and socket-specific syscalls before Flow hashes and submits the Docker configuration. The
Prime profile keeps its private loopback support. An ordinary command inherits no network socket
and cannot create, bind, connect, listen, accept, send, or receive through one.

Project `.flow` is always protected from the trusted project root. Each protected child of the
workspace becomes an inspected masked path. A protected path at or above the workspace rejects.
A workspace that contains the project root also rejects. A runtime support path cannot overlap
protected state.

Bounded, cancellation-aware sensitive workspace discovery runs before engine preparation. Existing
environment files, private-key files, `.flow` directories, and private Flow workspace collections
become masked paths. Existing Git metadata becomes an inspected read-only path inside the original
workspace bind. A linked or special `.git` entry becomes masked. This scan is not an atomic host
filesystem snapshot and does not contain concurrent mutation by the trusted host user or root.

The sandbox observes one versioned workspace snapshot after protection resolution. The snapshot
binds readable regular-file bytes, modes, directories, symlink targets, and masked exclusion
identities. It accepts at most 100,000 entries and 10 GiB of file content. Masked secret content is
not hashed. The workspace snapshot digest enters the submitted Docker labels. Flow re-observes the
same snapshot immediately before launch and rejects a mismatch.

The adapter inspects the complete selected Docker configuration before it grants launch authority.
Its canonical configuration digest becomes the public sandbox evidence policy digest. The digest
transitively binds the attested runtime-policy identity. It directly binds the submitted process,
environment, mount, mask, read-only path, workspace snapshot, and resource values.

The adapter publishes one owner-only durable intent before Docker create. It replaces that record
with the verified full container ID before it returns a launch. The record binds the boot identity,
process ID, process start ticks, complete Docker configuration digest, runtime identity, private
directory, and ownership nonce.

Before every prepare, recovery claims only records whose exact process owner is dead. Concurrent
prepares may share one active scan. A later prepare always starts a new scan. Thus, an owner that
dies after an earlier command cannot escape recovery.

Recovery rechecks current runtime authority and reconciles only an exact intent or full ID. It
removes the container, confirms absence, removes the private directory, and removes the durable
record last.
Foreign or unverifiable objects remain untouched and block progress.

The engine also retains a same-process settlement closure for a failed preparation or returned
lease. A later prepare settles every retained closure before descriptor resolution or Docker
create. This matters because the durable store must skip an intent whose exact owner process is
still alive. An ambiguous create remains an intent until a later authority check reconciles one
verified full ID. A known full ID can retry stop, remove, absence proof, private-directory removal,
and durable-record removal from its last proved phase.

The container profile separates filesystem, mount, PID, IPC, cgroup, and network namespaces. It
shares the Linux kernel and Docker daemon with the host. It is not a microVM, kernel-independent
boundary, or multi-tenant isolation layer.

On Linux, SRT can hide a read-denied directory with an ephemeral mask. A write call in that mask can
report success. The write changes only the mask and cannot change the host path. macOS rejects the
same write call. Flow tests the host path after each native command.

Flow creates new isolated child directories in an owner-only project-sibling collection. The
collection name is `.<project-name>.flow-workspaces`. A hash of the canonical physical run-store
path separates workspace groups. Filesystem aliases for one run store select one group. The project
workspace, the protected project `.flow` directory, and
the configured run store do not contain the collection. Flow rejects a linked collection or owner
directory. Attached runs use the canonical configured project root. Detached job records save the
same optional root and bind it to the job digest. For an old job without these fields, the worker
can infer the root from the durable `.flow/runs` ancestor. It accepts the root only when the job
directory is in that project.

Flow gives every child command the complete protected-path read and write deny list. Flow also
protects the `.flow` path in the child workspace. The broker denies each historical
`.flow-workspaces` or named `.<name>.flow-workspaces` path segment. Before command spawn, SRT scans
at most 200,000 execution-root entries and adds each existing private collection as a literal
protected path. It rejects linked or indirect collections. For a child, SRT denies reads from every
ancestor collection but permits writes in the selected workspace. Thus, a child cannot read a
sibling workspace at any nesting level. The snapshot copier omits these collections. A root command cannot read or write
an existing private workspace collection. On Linux, Flow rejects a command root that strictly
contains the configured project root. Linux SRT cannot protect a matching path that does not exist
when the sandbox starts.

Recovery can find a workspace in the old run-store location. Flow validates the old manifest with
its old exclusion identity. For a nested child, Flow translates the new parent path to its old
parent path. Flow then moves and syncs the complete workspace identity directory to the
project-sibling collection. Across filesystems, Flow uses a bounded, verified, and synced staging
copy. It publishes the copy with one rename and removes the old identity last. Flow reopens the
moved workspace. Its first recovery event records the old and new paths in
`run_resumed.workspaceRelocation`. A parent records this event before it starts recovery in that
child. Flow does not create new workspaces in the old location.

The port isolates Flow from the backend. Pi's official SRT and Gondolin examples validate this
tool-routing seam. Flow imports SRT as a containment primitive but owns policy, lifecycle, evidence,
and failure semantics.

The pinned SRT Linux implementation tracks concurrent active sandbox wraps. Mount-point cleanup
waits for the last command. Flow's coordinator preserves that backend contract. The container
adapter implements the same port without changing workflow or ledger
contracts. A future Gondolin, OpenShell, microVM, or managed adapter can do the same.

### Deterministic concurrent scheduler

An omitted workflow concurrency declaration preserves one active executable node. An explicit
`maxNodes` allows the scheduler to fill deterministic quiescent waves from declaration-ordered
ready nodes. Starts are durable before any admitted executor is invoked; all members settle before
outcomes are committed in admission order. Conditions, joins, approvals, and terminal decisions are
barriers. Once one member fails or cancellation is observed, no later wave is admitted, but the
current wave is allowed to quiesce so the ledger never invents abandoned work.

A bounded loop is compiled into one finite local DAG per possible iteration, an exact-evidence check
after each body, and a pure controller under the author-facing loop id. Iterations never overlap:
the next body entry depends on the prior check and requires its durable `continue`. Existing
`maxNodes` concurrency still applies to independent nodes inside the active body. A first `stop`
omits the remaining finite instances; a final `continue` fails the controller rather than
converting exhaustion into success. When the graph omits an enclosing condition branch, omission
propagates through that branch's loop controller instead of being interpreted as loop exhaustion.

A bounded optimization is compiled into one isolated child and one pure check for every possible
candidate, plus a pure controller under the author id. The first candidate depends on the typed
baseline; each later pair requires the prior check to continue. Checks recompute metrics and
invariants from canonical evidence, and only strict valid improvements can call the promotion
port. Stagnation omits the remaining finite pairs. Optimization is a graph barrier: every top-level
workspace mutation is ordered before or after it, so promotion never races an admitted parent wave.
The promotion adapter validates typed leaf identities and every unchanged intermediate directory
before prepare, then rechecks directory ancestors at each mutation boundary. An intermediate path
replaced by a stable symlink therefore fails stale instead of redirecting promotion outside the
workspace. This is pathname hardening for a cooperating local workspace, not an atomic defense
against a hostile same-user process racing between checks and filesystem operations.

The design deliberately separates completion timing from durable ordering. Effect prepare and
settlement events remain real-time write-ahead facts, while node outcomes, dependency release, and
primary-failure selection are deterministic. The reducer independently enforces the persisted
capacity, graph dependencies, outcome order, full-wave quiescence, and ordered cancellation set.
Concurrency is not workspace isolation for ordinary branches: mutations in the shared parent still
require explicit graph ordering. Authors can choose an explicit child node when independent
history, budget, result, and workspace isolation are required.

### Isolated child run trees

A compiled `child` node contains a recursively compiled workflow, its digest, one unconditional
terminal typed-result contract, and no runtime-specific session type. The compiler requires all
four child budget ceilings, rejects human waits, limits nesting to four levels, limits every
embedded source to 1 MiB, and counts the complete expanded tree against a 1,024-node ceiling.

The root-tree scheduler—not Pi, SRT, or the supervisor—owns child admission. Before materialization,
the parent appends a deterministic link derived from parent run, node, and attempt. A child-only
wave prevents parent-workspace executors from mutating the source while sibling snapshots begin.
Each child ceiling is reserved against bounded ancestor remainder, including sibling reservations;
actual resource totals are later charged to every ancestor in addition to the child node start.
This keeps the supervisor's one-worker-per-root-tree model and avoids routing descendants through a
capacity queue that could deadlock behind their own parent.

`WorkspaceIsolator` is an application port with create, reopen, and idempotent cleanup operations.
The initial backend materializes an owner-only reflink where supported and otherwise copies the
current dirty/untracked tree. It preserves modes and symlinks without following them, excludes Flow
and protected run state by normalized source-relative policy, verifies regular-file content and
source stability, rejects special files, records a durable manifest, and atomically exposes the
completed directory. The backend protects the parent from child mutations but is not an atomic
filesystem snapshot, process sandbox, or hostile-code boundary. A native APFS/Btrfs/ZFS/overlay,
Gondolin, OpenShell, container, or managed implementation can replace it behind the same port.

The child recursively invokes the normal run application with its own run id, owner record, JSONL
history, working directory, budget, and persisted execution-workspace provenance. The parent and
child share the cancellation signal and executor composition, but no mutable scheduler state. On
terminal settlement, the parent imports only the canonical typed result, child terminal sequence,
resource totals, duration, workflow identity, snapshot identity, and cleanup disposition. Ordinary
workspace changes are discarded. A compiler-registered optimization candidate instead retains a
successful workspace until its check captures, rejects, or promotes the delta; no other child may
enter that protocol. Cancellation between durable candidate success and evaluation starts no check
or later candidate and leaves the isolated workspace retained for diagnosis.

`CandidateWorkspaceManager` extends isolation with capture, promote, and reconcile operations.
Capture verifies the full parent snapshot still matches the fork, records bounded sorted
before/after identities, and stores content-addressed candidate blobs. It independently bounds
entry count, logical file bytes, and the 128 KiB serialized evidence manifest; an exact previously
captured manifest is reopened idempotently after interrupted event publication. Promotion rechecks affected
paths and removed-directory closures, stores rollback blobs before prepare, and applies a
deterministic saga under process and filesystem ownership. The local journal distinguishes
prepared, applying, rolling back, rolled back, committed, and unknown states. Replay-visible
lifecycle callbacks are the authority for prepare and settlement; the filesystem adapter cannot
advance the graph itself.

Recovery uses two write-ahead boundaries. Parent `node_started` fixes child identity before
materialization. Child `run_started` fixes workspace provenance before child execution. With no
child ledger, the claimed parent can discard a stale pre-ledger directory and recreate it. With any
child event, recovery must reopen the exact manifest and resume the exact ledger; it never creates a
replacement. A terminal child history can be imported after an idempotent cleanup even when the
parent outcome append previously crashed. Missing or divergent nonterminal state fails with typed
recovery refusal.

Ready child workflows can overlap under parent concurrency. The current SRT backend has a narrower
process-global lifecycle: same-workspace command wraps share a session, while incompatible child
workspaces wait for reset and reinitialization. This serializes those command phases without
changing graph admission or rejecting the second child. A backend with independent sessions can
provide full command overlap without changing domain or application contracts.

### Live agent-command decision transport

The application owns a provider-neutral decision-source port. The local implementation stores one
owner-only JSON receipt below
`.flow/runs/<run-id>/agent-command-approvals/<request-id>.decision.json`. Submission writes and
syncs a temporary file, then atomically hard-links it into the final no-overwrite path. Attached and
detached execution use this same mechanism; no supervisor-only RPC is required. The owner opens the
receipt non-blocking and no-follow, requires a regular file, and reads at most 16 KiB through a
fatal UTF-8 decoder before strict JSON validation.

The receipt is transport evidence, not execution authority. The CLI derives its fields from the
current read-only ledger projection and cannot append while the live owner holds the run. The owner
revalidates every identity field before appending `agent_command_approval_granted` or
`agent_command_approval_denied`. Invalid, broken, or aborted waits append a typed cancellation and
never prepare a process. Receipts remain immutable for audit. Reducer state makes grants expiring
and single-use and rejects dangling grants at node settlement.

This design intentionally does not solve remote or multi-user approval. Actor labels are local
attribution, not authenticated identities, and a same-user writer to the run directory is inside the
administrative trust boundary. A process crash while Pi has an open tool call remains an opaque
session-continuation problem and fails closed on recovery.

### Event and evidence store

Persists transitions before the scheduler advances. Model transcripts are optional diagnostic
artifacts; they are never authoritative for graph position or completion. `run_started` persists a
bounded control-graph projection whenever control semantics or concurrent execution require it.
`node_result_published`, `node_condition_evaluated`, `node_loop_checked`, `node_loop_completed`,
`node_omitted`, and `node_joined` record resource-neutral control transitions. For a typed result,
replay reparses the original durable evidence with the persisted bounded schema, reproduces its
RFC 8785 canonical JSON, and verifies source, schema, canonical bytes, and value hashes. Other
control replay recomputes source identity, selected case or loop decision, guard, dependency
propagation, and completion result before accepting it. Truncated source evidence produces a typed
control failure. Child starts persist deterministic run/workflow/result/schema linkage; child
outcomes bind terminal sequence, typed value, resource totals, workspace backend/digest, and cleanup
disposition. Replay validates that projection against the persisted child control contract and
charges its resources to the parent. Optimization events persist recomputable metric/invariant
observations, complete typed delta entries, promotion boundary, settlement, cleanup, best state,
and stop reason. Replay rehashes the delta manifest and validates every transition against the
finite graph and child evidence. Policy decisions prove authorization. `node_effect_prepared` proves Flow reached a
specific edit boundary before rename; `node_effect_settled` records an executor's committed,
not-applied, or post-commit-unknown state; `node_effect_reconciled` records what recovery later
observed for a still-open edit; terminal receipts project only executor-settled effects. None is
substituted for another. The effect journal constrains failure classification as a lower bound: an
unknown settlement requires uncertainty and a committed settlement forbids a side-effect-free
failure, while provider or cleanup uncertainty may conservatively remain uncertain even when every
recorded edit is committed or not applied. A recovery observation never terminalizes its open
attempt. Only a separate `node_attempt_interrupted` event—validated against the persisted opt-in,
attempt cap, effect proof, and resource limits—archives the attempt and permits the scheduler to
start the exact next fresh attempt.

Fresh and recovered execution publish an atomic per-run ownership record containing a process ID and random token before appending. A live owner blocks competitors; an exited owner can be displaced atomically. Recovery replays the committed JSONL prefix and verifies the exact compiled workflow digest, node set, budget, concurrency, approvals, and recovery requirements. It reconciles every open effect and classifies every open attempt in workflow declaration order. Every proof-safe attempt receives one `node_attempt_interrupted` event before the single `run_resumed`; an unsafe sibling still blocks execution without erasing the durable safe dispositions or reconciliation prefix. A crash among these dispositions is replay-safe because archived attempts are already pending with their counters retained. A final unterminated record is uncommitted and is truncated before the recovered owner appends. Ownership is local-host coordination, not a distributed lease or security boundary.

### Local detached supervision

The auto-started local supervisor is a control-plane router, not another scheduler. A detached
submission contains the exact workflow source, normalized execution directory, run identity, and
run/resume mode plus the effective policy digest. The supervisor compiles that input before mutation
and first journals an exact request digest. Under one serialized admission operation, it either
reserves active capacity, assigns a durable FIFO queue ticket, or records deterministic queue-full
rejection. Dispatch and queue decisions persist the immutable job snapshot before the admission
event; queue-full rejection retains only compact command and admission facts. Active capacity is
reserved before process launch. The worker alone constructs the executor, claims the run store, and
calls the existing application scheduler.

Admission is a separate owner-only append-only JSONL ledger under `<runs-dir>/.supervisor`. Its
strict reducer enforces active and queued bounds, unique increasing queue tickets, FIFO dispatch,
job identity, and legal cancellation/release transitions. Records are appended and synced before
acknowledgement. Recovery repairs only an unterminated final fragment and fails closed on committed
corruption. The store atomically compacts a committed prefix to a complete replayable snapshot after
a bounded number of transitions or before its byte ceiling would be crossed. Run events remain the
only graph authority; admission events prove only control-plane capacity and ordering.

Concurrent clients serialize auto-start through an owner-only startup record. Only its holder may
remove a stale socket and spawn a generation; other clients poll the advertised endpoint. A dead
holder can be displaced, while a live or PID-reused holder blocks conservatively.

An authenticated worker adoption gate separates process creation from job acceptance. The worker
publishes an owner-only descriptor and private control socket, then waits. After a supervisor
requests adoption, the worker durably changes to `running`, returns its worker id, run id, PID,
random token, and immutable job digest, and waits for that identity response to flush before
entering the scheduler. This closes both the fast-job race and the immediate-cancellation gap. If
resume durably narrows an open effect and then refuses the unfinished attempt, the worker records a
typed recovery code and the replayed `running` run status before exiting. The admission plane
releases that worker slot without relabeling the authoritative run as failed.

Client and worker control use strict, versioned, one-request JSONL frames with bounded UTF-8 bytes,
unknown-field rejection, request identifiers, and structured failures. Event replay reads the
normal validated Flow ledger in pages strictly after an exclusive sequence cursor; the supervisor
does not retain an unbounded client queue or reinterpret run state. Submissions and cancellations
are durably journaled before their consequential step and are idempotent by command id and exact
request digest. Cancellation reaches only a token-authenticated active worker. Mid-node
cancellation preserves settled evidence and records an attributed `run_cancelled` event; already
committed budget exhaustion retains terminal precedence. CLI callers may supply and persist a UUID
before the first mutating request; generated keys are returned for interactive convenience but
cannot by themselves recover a response lost before the caller observes it.

Workers are independent process groups. A supervisor crash therefore does not terminate them. A
new generation scans durable claims and descriptors and adopts only workers that pass the same
identity handshake. PID liveness alone never grants authority because PIDs can be reused. A dead
worker with an open node attempt remains governed by the same persisted recovery policy and effect
proof as foreground work. The control plane does not invent an outcome or independently replay the
work; unconfigured attempts still report `uncertain_operation`, and ineligible opt-ins report
`recovery_retry_ineligible`.

The supervisor descriptor, every stateful request, and the admission ledger bind the canonical
effective capacity digest and exact limits. Read-only status reports the live binding even when the
caller's newly resolved values differ; every stateful command fails before mutation on that
mismatch. Shutdown refuses active or queued admission; explicit idle shutdown archives the old
ledger so a later generation may bind changed effective values. Status work is proportional to live
claims and admission state rather than lifetime worker history, and returns only bounded worker
summaries plus active/queued counts.

Durable control metadata lives under `<runs-dir>/.supervisor` with owner-only directories and files,
no-follow reads, bounded schemas, atomic replacement, and sync-before-acknowledgement. Ephemeral Unix
sockets live in a short owner-validated `/tmp/flow-harness-<uid>` directory because macOS limits
socket path length. A digest of the canonical runs directory namespaces endpoints. This is
same-host, same-user coordination—not authentication against the same user, a distributed lease,
or a sandbox.

### Durable command approval

The current approval slice is a scheduler pre-start gate for deterministic command nodes. Run start
captures the approval declaration and normalized execution directory. When the node becomes ready,
the scheduler derives an exact `process.execute` operation, persists its SHA-256-bound request, and
returns `waiting_for_approval` before `node_started`, sandbox preparation, or process spawn.

Approval and denial are separate application operations over the recoverable event-store port. They
require no workflow file, executor, Pi session, or model credential. Approval records an attributable
single-use grant with a bounded expiry but does not execute; resume with the exact workflow and
working directory consumes it. An unused expired grant returns to a new durable wait. Denial creates
a side-effect-free committed node failure and terminal run. The same owner record serializes
decision-versus-decision and decision-versus-resume races.

The actor label is asserted local audit metadata, not authenticated identity. Request ids are
sequence-derived locators rather than bearer secrets. Remote callbacks remain separate.

### Live agent-command approval

An agent `toolApproval.exec` rule is an in-session barrier over a single Flow-owned tool call. The
active owner persists the complete request and suspends the Pi tool promise. A second local CLI
process reads that projection and publishes one immutable decision sidecar without claiming the
ledger. The owner validates the exact context and appends the authoritative decision. Grant
consumption and command preparation are atomic; denial returns to Pi as a tool error. The same
decision-source port and filesystem channel serve attached and detached execution.

This capability does not imply opaque recovery. If the owner dies with Pi suspended, Flow keeps the
request inspectable but cannot recreate the transcript or promise and refuses resume. Remote
callbacks, authenticated multi-user decisions, and persisted Pi session continuation remain
separate capabilities.

### Durable graph approval

An `approval` node is a pure control barrier over already-durable evidence. Its declaration binds a
bounded prompt and one to sixteen ordered, unique source references. Every source is a compatible
direct dependency selecting command standard output/error or agent text. The scheduler waits for a
quiescent executable wave, rejects truncated evidence, and persists a request snapshot containing
the workflow digest plus each source node, attempt, field, and hash.

Approval and denial reuse the same exclusive application decision path and CLI as command approval,
but emit dedicated events. Approval immediately succeeds the control node; denial immediately
creates a side-effect-free, non-retryable node failure. Neither transition invokes an executor or
consumes a node start. There is no grant or TTL because no later operation creates a
time-of-check/time-of-use boundary. The request does not authorize a command or model tool and does
not expand policy or containment authority.

### Durable resource accounting and budgets

Every run reconstructs provider-neutral resource consumption from authoritative events: committed
node starts, evidence duration rounded up to whole milliseconds, four model-token components,
provider-reported cost normalized to integer micro-USD, and UTF-8 bytes in retained primary
executor payloads. The Pi adapter obtains its observation from
`getSessionStats()` and translates it before the application or domain sees it. A future executor
must produce the same Flow evidence shape; provider transcripts and runtime-specific settings never
become graph authority.

An optional compiled budget limits starts, total model tokens, reported model cost, active
execution duration, and retained artifact bytes. The scheduler consults only reduced run state
before work and after outcome settlement. It appends `run_budget_exhausted` and produces distinct terminal
`resource_exhausted` state rather than treating exhaustion as success, cancellation, or an invented
node failure. Recovery validates the exact persisted limits and reaches the same decision after a
crash between the node outcome and terminal event.

The active-time limit also narrows executor authority: a node receives the lesser of its declared
timeout and remaining allowance. For approval-required commands, this effective timeout is part of
the exact persisted operation before the client detaches. Human wait and process downtime consume
no active duration because only committed evidence contributes.

Artifact bytes are derived from command standard output/error, agent text, model-verifier raw
output, nested command-verifier output, and verified child totals. Derived verdict/reason/result,
approval, hash, policy, effect, sandbox, and control metadata is not charged again. Failed evidence
is charged when committed; missing evidence is zero. Child ceilings are reserved before launch,
while only the verified child tree total becomes consumed evidence and rolls up once per ancestor.
Before a nonterminal parent resumes, the application recursively re-reduces every settled child
ledger and compares the complete imported projection, so a forged terminal sequence, outcome,
result, provenance, duration, or resource total fails closed before more work starts.

These are settlement ceilings, not prepaid billing or physical-storage controls. Provider usage is
authoritative only after a response, so one response can overshoot. Flow keeps the full observation
and schedules no downstream work. External organization quotas, price catalogs, invoice
reconciliation, distributed reservation, CPU/memory/disk limits, artifact storage,
content-addressed storage, spill, download, retention, and garbage collection remain separate
capabilities. Per-run graph-node concurrency and supervisor-wide detached-worker admission are
independently bounded.

### Evaluators

The goal evaluator is a pure domain transition: it receives only a compiled criterion-to-verifier binding and authoritative node outcome metadata. It receives no prompt, transcript, filesystem handle, executor, or tool, and therefore cannot mutate the workspace or infer acceptance from implementation rationale. A terminal legacy command retains its exit-based decision. A first-class verifier projects its typed `accepted`, `rejected`, or `inconclusive` verdict directly.

The verifier executor is a separate application seam. Its command driver delegates to the existing sandboxed command executor and preserves nested evidence and side-effect uncertainty. Its model driver receives only declared durable evidence, invokes a separate Pi session with a dedicated immutable system prompt and zero tools or project discovery, and parses one bounded strict JSON verdict. The persisted contract contains Flow-owned provenance, hashes, usage, and source observations rather than Pi or provider types. Only accepted evidence succeeds the node. This isolation limits authority and context but does not make probabilistic evaluation prompt-injection-proof or equivalent to deterministic hidden checks.

## Current trust boundaries

Pi intentionally has no built-in security boundary and the host-side agent runtime still runs with the invoking user's operating-system permissions. Flow therefore distinguishes the agent-tool authorization boundary from the command containment boundary.

- Agent nodes receive only declared Flow-provided `read`, `ls`, `edit`, and argv-only `exec` tools plus exact selected declarative command tools; implicit project extensions and resource discovery are disabled. Reads include an exact-byte full-file SHA-256 version. Edits require that version, preflight exact unique Unicode-scalar replacements, coordinate same-file mutations across cooperating same-host Flow processes, atomically replace one existing UTF-8 target, and protect durable/sensitive project paths at every path depth. Stale versions fail without fuzzy or three-way recovery.
- Every command node and descendant executes inside SRT on Linux or macOS. Agent commands execute only after Linux SRT binds a canonical root-owned Bubblewrap executable outside the workspace and proves PID-namespace lifecycle containment; process-group-only macOS preparation is denied before spawn. Flow preserves argv boundaries through an audited POSIX encoder, passes an explicit environment allowlist, denies network and undeclared Unix sockets, and protects the actual run-store path. Linux execution canonically resolves and re-exposes only SRT's required seccomp helper read-only when the harness installation is outside the selected workspace.
- Missing dependencies, seccomp degradation, unsupported platforms, initialization errors, and invalid launch descriptors fail closed with no command spawn. There is no unsandboxed fallback.
- Each new command result records the backend, exact backend version, named profile, and semantic policy digest. Backend and profile values use bounded machine identifiers rather than an SRT-only persisted union, preserving the event shape for future adapters. Generic command-node replay keeps the added field optional for older ledgers; protocol-v1 agent-command settlements require it, independently bind retained stdout/stderr prefixes by hash and UTF-8 byte count, and persist distinct timeout, abort, and termination observations.
- Approval-required commands persist the exact executable, argv, normalized working directory,
  timeout, digest, request, and grant lifetime before a start. A grant authorizes only that scheduler
  transition; it neither expands the sandbox profile nor predicts every transitive process effect.
- Graph approval requests persist the exact prompt and ordered hashes of complete durable evidence.
  Approval completes only that pure node; it grants no execution, tool, sandbox, or policy authority.
- Run budgets constrain scheduler admission and effective timeouts, but they are not a sandbox,
  provider-side reservation, account quota, or guarantee that one in-flight response cannot exceed
  its remaining reported-cost allowance.
- Supervisor metadata and random worker tokens coordinate processes belonging to one local account.
  They do not defend against that same operating-system user or root, and no TCP or remote control
  endpoint is exposed.
- Operator/project capacity configuration can bound detached workers and queue depth, but it is not
  process containment, a provider quota, or a run resource budget. Projects may narrow an operator
  ceiling and cannot widen it.

Native sandboxing is not equivalent to a microVM. SRT is a beta dependency built on Seatbelt on macOS and bubblewrap, namespaces, and seccomp on Linux. Kernel or sandbox-runtime vulnerabilities remain outside Flow's enforcement model, and the host-side Pi process is not contained by this command adapter. Hostile workloads still require a reviewed container, microVM, Gondolin, OpenShell, or managed isolation boundary.

The application-level workspace broker prevents ordinary traversal and symlink escapes. A target-local lock prevents concurrent edits by cooperating Flow processes on the same host and recovers locks whose same-host owner has exited. It is not a distributed lease and does not make pathname authorization and use atomic against a concurrently hostile or non-cooperating process. The command sandbox reduces the authority of command descendants; it does not turn the whole harness into a complete host security boundary.

Approval remains separate from containment. OMP-style allow/prompt/deny rules can decide whether an exact operation is authorized, but authorization cannot replace containment of that operation's transitive effects. Flow currently proves that separation for deterministic command gates and evidence-bound graph gates; dynamic agent tools still require resumable session state.

## Target invariants

1. Editing workflow YAML changes execution without editing a prompt manual.
2. Only the compiled graph can select a ready node.
3. A transition is not visible until its event and outputs are durably recorded.
4. A criterion cannot pass without current evidence linked to that run and criterion.
5. Deterministic evidence wins over conflicting model judgment.
6. Project configuration and packages cannot weaken the immutable safety floor.
7. A skill or package can narrow authority but cannot expand its own authority.
8. Every side-effecting node declares idempotency and recovery behavior.
9. Compaction and model changes cannot erase authoritative state.
10. Cancellation propagates to the model stream, active tool process, and children; it starts no
    later optimization decision or promotion. Candidate cleanup is replayed only after a durable
    rejection or conclusive settlement, while a pre-evaluation retained candidate remains diagnostic
    state.
11. Resource consumption and exhaustion are reproducible from Flow events without a provider transcript.
12. Supervisor health metadata cannot override, repair, or replace authoritative ledger state.
13. Every detached worker has a prior durable active reservation, and active plus queued admission
    never exceeds the effective policy.
14. A writable node cannot publish a terminal outcome while a prepared workspace effect is
    unresolved or while its terminal receipts differ from the settled effect journal.
15. A fresh attempt cannot start until the prior attempt's interruption disposition is durable and
    every recorded effect is proven not applied.
16. An unselected branch is represented by durable omission, and only its declared join may
    reconcile omitted alternatives with the selected successful terminal.
17. Every loop is finite at compile time; iteration identity, exact stop evidence, and unused
    iteration omission are replay-authoritative rather than inferred from prompts or node ids.
18. No later loop iteration starts unless the immediately prior check durably continued, and
    reaching the final bound without a stop fails closed.
19. A typed result is reproduced from durable source evidence and its closed schema during replay;
    stored canonical bytes or hashes alone never authorize publication.
20. Every child event history has one deterministic parent node attempt, exact workflow/result
    contract, independent owner, and persisted workspace provenance.
21. A child workspace is never replaced after its first durable child event, and no child result is
    imported until the workspace has a recorded cleanup disposition.
22. Only a strict invariant-preserving metric improvement can prepare candidate promotion; every
    rejected candidate leaves the parent unchanged.
23. Promotion prepare, local settlement, cleanup, check completion, and controller completion are
    distinct durable boundaries; unknown affected-path state blocks all downstream execution.
24. A later optimization candidate cannot start after the immediately prior check reaches
    stagnation, cancellation, or resource exhaustion.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid workflow or configuration | Reject with path-specific diagnostics before creating side effects |
| Workflow package locator, identity, manifest, or exact version is invalid or unavailable | Reject admission before constructing a run ledger or invoking an executor; never select a range, tag, or implicit latest version |
| Workflow package changes during capture or disagrees with its durable snapshot | Stop the bounded capture or reject the mismatch; never fall back to live source |
| Workflow package cycle, expansion limit, or undeclared replay package is observed | Reject compilation or replay before any affected node starts |
| Result JSON is malformed, duplicated-key, non-I-JSON, oversized, too complex, truncated, or schema-incompatible | Record the exact typed side-effect-free control failure and start no dependent work |
| Result publication identity, schema, canonical value, or hash is forged | Reject replay before advancing or executing another node |
| Child source, nesting, result, wait, budget, or tree bound is invalid | Reject the root workflow before creating its ledger or workspace |
| Child ceiling exceeds an ancestor remainder | Fail the child node before workspace materialization |
| Child workspace is missing or divergent after its ledger starts | Refuse recovery; never create a replacement or infer an outcome |
| Child cleanup fails | Retain the workspace, record retained disposition, and fail the parent child node |
| Parent crashes after child terminalization | Replay the terminal child ledger, retry idempotent cleanup, and import the same evidence once |
| Candidate result is equal, worse, invariant-failing, failed, cancelled, exhausted, or has no file delta | Record rejection and stagnation; discard its workspace and leave the parent unchanged |
| Parent or an affected directory closure changed after candidate isolation | Refuse promotion before prepare and preserve the newer parent state |
| Promotion fails after prepare | Complete deterministic compensation or record unknown; never infer acceptance |
| Process exits after promotion prepare or local commit | Reconcile the exact journal and delta; do not rerun the child or reapply a proven commit |
| Persisted optimization metric, invariant, delta, settlement, cleanup, or stop claim is forged | Reject replay before any later candidate or downstream node starts |
| Condition source is truncated or incompatible | Record a typed control failure and never select a branch from partial or mismatched evidence |
| Branch or join event is forged, premature, or inconsistent | Reject replay before advancing or executing another node |
| Loop graph, check, omission, completion, or iteration order is forged | Reject replay before advancing or executing another node |
| Loop stop evidence is truncated | Record `loop_source_truncated`; execute no later iteration |
| Final loop check continues | Record `loop_limit_reached`; start no downstream work |
| Missing credentials | Fail startup or enter a durable operator-wait state |
| Provider outage or rate limit | Record the attempt and apply only the declared bounded retry or fallback policy |
| Malformed model output | Schema-reject, retry within the node budget, then block with evidence |
| Unauthorized tool request | Deny before execution and record a policy event |
| Stale or invalid edit before preparation | Reject the entire replacement before rename and record no effect event or receipt |
| Edit is prepared but fails before rename | Settle it as not applied when publication remains available; record no terminal receipt |
| Edit fails after atomic rename | Settle it as post-commit unknown when publication remains available, project an uncertain receipt, and fail the node with uncertain side-effect status |
| Settlement append rejects | Poison later publication and retain the unresolved prepared effect; do not infer an outcome from target bytes |
| Process dies between edit boundaries | Reconcile each open typed edit under its target lock; retry only an opted-in attempt whose complete replay proves every effect not applied |
| Sandbox unavailable or degraded | Fail before command spawn; never fall back to host execution |
| Sandbox cleanup failure after spawn | Fail with uncertain side-effect status; never report command success |
| Process-tree termination is unconfirmed and sandbox cleanup also fails | Preserve termination failure as the primary outcome, record cleanup failure as bounded secondary context, and retain unconfirmed termination evidence |
| Tool timeout or crash | Terminate the process tree where possible and classify side-effect uncertainty |
| Partial external mutation | Reconcile authoritative external state; compensate only when explicitly supported |
| Verification failure | Record failing or inconclusive evidence and never coerce success |
| Concurrent workspace changes | Detect baseline drift and pause before absorbing the changes |
| Crash during persistence | Recover to the last committed event and tolerate an incomplete trailing record |
| Client exits after detached acceptance | The authenticated worker continues with independent standard streams and process group |
| Supervisor exits while workers run | Workers continue; a replacement generation adopts only token-authenticated matching identities |
| Worker exits with an open attempt | Preserve ledger truth; apply the same opt-in proof gate during a later resume and never infer or retry ambiguous work |
| Duplicate detached submission | Reuse the durable immutable job/claim for the exact request or reject a conflicting request without a second worker |
| Concurrent supervisor auto-start | One startup-lock holder launches; all other clients attach to the resulting generation |
| Active capacity exhausted | Persist one FIFO queue ticket when queue capacity remains; otherwise return a durable `queue_full` rejection without retaining a workflow snapshot |
| Queued cancellation races dispatch | Serialize both transitions; either remove the queued job without creating a worker/run ledger or continue through authenticated active cancellation |
| Effective capacity changes | Reject a mismatched stateful request before mutation; require explicit shutdown after the old generation becomes idle |
| Admission ledger grows | Atomically compact a committed prefix to a replay-equivalent snapshot before transition or byte bounds are exceeded |
| Cancellation acknowledgement is lost | Reconcile the durable command record with ledger state; never blindly dispatch an uncertain mutation again |
| Oversized, malformed, or incompatible IPC | Reject the bounded frame before a mutating handler runs |
| Corrupt state or failed migration | Preserve original data, fail closed, and provide exportable diagnostics |
| Resource exhaustion | Preserve the full committed observation, append explicit exhaustion, start no downstream work, and never infer success |
| Approval grant expires unused | Execute nothing, record expiry, and return to a fresh durable request; never infer consent |
| Incompatible package | Reject or quarantine it without changing active runs |
| Agent Skill is missing, duplicated, unsafe, oversized, or changes while being snapshotted | Reject before ledger creation or detached reservation; never fall back to partial or live content |
| Agent Skill source changes after submission | Continue from the immutable submitted snapshot; do not absorb the changed source into attached, queued, child, or resumed work |
| Agent reports an undeclared selection or forged resource read | Fail the node before persisting success, or reject replay/recovery before later work starts |
| Verifier package is missing, malformed, unsafe, oversized, kind-incompatible, version-mismatched, or changes during capture | Reject the complete selection before ledger creation or detached reservation; execute no verifier |
| Live verifier manifest changes after submission | Continue from the immutable submitted snapshot; bind no live replacement during attached, queued, child, or resumed work |
| Verifier evidence reports the wrong package identity | Fail before persistence or reject replay; never infer identity from a successful driver result |

## Evaluation layer

Harness evaluation is an application layer above ordinary workflow execution. An ordinary run
ledger remains authoritative for one profile trial; a separate evaluation ledger owns the admitted
plan identity, deterministic paired schedule, terminal trial classifications, cross-run metrics,
and comparison verdict. Neither reducer imports the other's event vocabulary.

The `HarnessEvaluationAdapter` port receives one fresh workspace and one task instruction. It also
receives public trial identity and fixed controls. It receives no verifier body or store authority.

The `flow-workflow-v1` adapter executes an admitted workflow through the Flow scheduler.
`pi-native-v1` and `omp-native-v1` use the same separate process runtime. All three adapters return
the same trial result contract.

The native external runtime has three parts:

1. A trusted registry verifies the driver, executable, local modules, harness closures, and SRT
   closure.
2. Linux SRT starts the driver in a verified PID namespace with protected host paths and no task network.
3. A host broker makes model requests without giving credentials to the child.

Two private pipes carry strict signed JSONL frames. The parent owns timeout, cancellation, process
termination, and process evidence. Each driver owns its harness translation and bounded metrics.
The model can use only workspace-confined `read` and `edit` tools.

The Pi driver runs the pinned Pi SDK under Node.js. The OMP driver runs the pinned OMP SDK under
Bun. The OMP session disables ambient extensions, skills, rules, MCP, memory, LSP, project context,
and persistence. Its custom provider sends bounded model context to the Flow host broker.

The OMP registry accepts only complete executable hashes from the built-in official Bun release
attestations. It hashes runtime Markdown and the package-resolution graph. It observes each
directory that can change dependency resolution. Bun starts without environment-file loading,
automatic installation, or workspace configuration.

The OMP descriptor supplies a canonical `NODE_PATH` for selected package resolution. This value is
trusted search metadata. SRT grants read access only to the exact selected package roots. It keeps
each search container and each unselected sibling package denied. Flow rejects a package root that
contains an unselected nested package.

Immediately before process start, the external runtime compares the prepared SRT containment,
backend, version, profile, and policy digest with the admitted runtime identity. It releases the
sandbox and rejects the trial if a value differs.

The application stores a durable adapter-start record before it calls either adapter. A restart
converts an unresolved start to one interrupted failure. It does not repeat the adapter call.

The native external runtime fails before spawn on macOS and Windows. Process-group cleanup does not
prove full descendant termination.

Prime Agent implements the same provider-neutral runtime port through an OCI adapter. The public
plan, record, report, and verifier contracts stay Flow-owned.

The adapter builds one fixed image twice during explicit preparation. It binds both OCI digests,
the software inventory, Node, Python, Prime Agent, the supervisor, and the driver.

One final-image probe hashes the Flow driver closure and each native executable. The protected
attestation stores these values. Plan admission does not look for container binaries on the host.

Each trial gets one durable container lease and one daemon-global slot. The host broker owns model
access. A signed inner protocol and a bounded outer protocol keep the container untrusted.

The supervisor imports one exact fixture tree into quota-backed memory storage. It removes every
Python process before it exports one exact result tree. Flow then replaces the host workspace
through its durable replacement journal.

Normal completion, timeout, cancellation, and recovery all require confirmed container removal.
An uncertain removal keeps the durable lease and blocks later Prime work.

Admission hashes portable fixture content, the instruction, workflow source and compiled graph,
private verifier identity and assertion count, controls, suite version, profiles, and seeds. The plan digest derives an
alternating paired schedule. Every trial receives a fresh reflink-or-copy workspace and a second
fixture observation before adapter execution. The private Flow-owned filesystem verifier runs only
after adapter settlement. A trial record is then appended to a separate digest chain under a
single-writer owner, after which the ephemeral workspace is discarded. Resume removes deterministic
committed or uncommitted workspace residue before starting the missing suffix. Offline inspection
reproduces the report from the redacted header and committed records without consulting live source
files or a provider.

Offline replay reconciles each record to the admitted verifier digest and assertion count. Comparative
inference uses only complete holdout pairs whose runtime environment and starting snapshot match.
This separation makes missing trials, crashes, false completion, and unavailable metrics explicit.
It does not make task selection representative, control provider stochasticity through the schedule
seed, or turn a bootstrap interval into a universal performance claim. See
[Reproducible harness evaluation](evaluation.md).

## Adaptive candidate and activation layer

Gate 7 sits above evaluation. A complete evaluation can produce a canonical tuning-only evidence
packet. The packet omits regression data, holdout data, verifier evidence, run handles, and schedule
positions. Admission rejects contradictory outcomes, incomplete pairs, and impossible schedules.

A `PromptCandidate` is inert supplemental state. It binds an exact baseline, exact tuning evidence,
a workflow scope, and prompt replacements for existing root agent nodes. Admission performs stable
no-follow reads and verifies each declared hash. It changes only the declared prompt fields.

An `AgentSkillCandidate` is a sibling inert source. It binds the same evidence model to one exact
workflow and one selected Agent Skill package. Admission snapshots the baseline package once,
projects only declared existing UTF-8 resource replacements, and produces immutable baseline and
candidate capability snapshots. Package authority fields and the workflow identity cannot change.

An `AgentSkillPackageCandidate` is a third inert source. An operator-owned content-free blueprint
fixes one package authority, one root agent target, and 1–16 exact paths. One zero-tool model turn
returns only inert UTF-8 contents. Flow publishes `CANDIDATE.json` beside the exact generated
`skill/<name>/` tree. It excludes scripts, executable or binary files, links, special files, and
model-selected paths.

The generation services use the provider-neutral `AgentExecutor` port. The Pi adapter is the first
implementation. Flow creates one agent request with no tools, skills, or packages. Prompt
generation includes only selected root-agent prompts and tuning-only packets. Agent Skill
generation includes the closed workflow identity, exact public package identity, tuning-only
packets, and only the selected existing UTF-8 resource bytes. A future model adapter can use the
same application port and strict domain contracts.

The model returns one strict prompt-replacement, Agent Skill resource-replacement, or declared-file
content object. Flow adds trusted source hashes and generation provenance. Flow checks all source
identities again, validates the ordinary candidate projection, and publishes through a
same-directory no-replace operation. Package synthesis uses a private staged directory and an exact
output lock. It syncs and reopens the complete tree, refuses an observed existing output, and then
uses one same-parent rename.

A failure before the hard-link commit leaves no final candidate file. A failure after the commit
returns `publication_uncertain`. One complete final file can exist in this state. A pre-commit
failure with an unsettled lock returns `cleanup_uncertain`. No candidate commits in that state, but
the lock can block another publication.

The standard compiler creates the projected workflow. The `flow-workflow-v1` adapter evaluates that
projection against the exact declared baseline. The evaluation header stores the complete public
candidate identity without prompt bodies.

For an Agent Skill candidate the compiler output is identical for both profiles. The adapter passes
the original package snapshot to the baseline and the projected package snapshot to the candidate.
The workflow runner performs the ordinary capability binding and evidence checks. The scheduler,
executor, verifier, policy, sandbox, and result contracts do not branch on candidate kind. Durable
identity stores both capability digests without resource contents. Trial execution and offline
inspection do not consult live catalogs.

For an Agent Skill package candidate, the baseline profile compiles the original workflow and has no
capability package. The candidate profile compiles the one-field skill-selection projection and has
exactly the generated package. The durable plan and store recompute both workflow identities, both
capability states, and the candidate cross-bindings before execution or replay.

An operator can activate only a complete superior evaluation. Preview creates a deterministic
proposal from the current head, target, actor, and reason. Apply holds one cross-process mutation
lock and requires the exact proposal digest.

Legacy activation remains unchanged. Its store contains immutable content-addressed artifacts, one
atomic index, and a hash-chained transition history. Existing readers preserve the original bytes,
digests, public views, execution behavior, and rollback selectors.

The effective harness layer composes later reviewed changes. `candidate compose` reads one ordinary
candidate, the exact current head, and its complete state. It projects only the declared prompt,
Agent Skill resource, or generated Agent Skill package surface. The resulting immutable artifact
contains the complete baseline state, complete candidate state, baseline head, candidate identity,
and one content-free surface delta.

Composition authenticates the ordinary candidate against its own immutable baseline before it
rebases that one declared surface onto the current complete state. Prompt rebasing copies only the
declared prompt fields. Resource rebasing replaces only the exact selected package. Generated
package rebasing changes only the declared empty-to-selected skill field and adds that package.
The current target must equal the candidate's before-state, so an orthogonal reviewed change is
retained while a stale same-surface candidate fails closed.

An effective state contains exact workflow bytes and the complete ordered non-policy package
closure. The state excludes policy packages and nested activation objects. Its digest binds the
canonical project scope, workflow identity, optional root workflow package, and every package. The
head also binds the workflow, generation, selected state, selected activation, and last transition.
This prevents an ABA change from presenting an old state as the current baseline.

The effective store writes state and candidate dependencies before it replaces one atomic index.
The index retains every activated state, artifact, transition, and workflow origin. Staged states
and artifacts remain inert physical inventory until activation and count toward the same fixed
store ceilings. History is hash-chained.
Apply rechecks the exact head under the shared activation mutation lock. A pre-head failure keeps
the old head authoritative.

A post-head failure reopens the durable index. It reports a settled or uncertain result. This
release performs no automatic garbage collection.

New runs can use `activation:<workflow-id>`. Admission prefers an effective head and falls back to
the legacy store only when no effective head exists. Effective admission reconstructs the selected
state from its workflow bytes, ordered package closure, and compact runtime proof. It rejects
missing, extra, reordered, or substituted packages. Current policy packages are then applied as a
separate overlay and are not part of the rollbackable state.

The run stores the complete selected workflow, packages, content-free head, and runtime proof in its
capability snapshot. Attached execution, detached workers, child ledgers, resume, recovery, replay,
and public inspection use that saved snapshot. They do not read the current index, review directory,
blueprint, evidence, registry, credentials, or live skill catalog.

Attached execution protects the canonical project `.flow` directory. A detached job stores the same
protected path in its immutable record. The worker gives the saved path to each node executor.

Effective rollback appends a distinct transition and selects any retained complete state by digest.
It changes only the head for future runs. It does not change active runs, restore prior policy,
rewrite source files, or delete retained dependencies. Once a workflow has an effective head, the
legacy writer and legacy rollback selectors cannot replace it.

A prompt candidate cannot change graphs, tools, skills, packages, models, policy, approvals,
budgets, verifiers, retries, or routing. An Agent Skill candidate can change only declared existing
resource bytes while preserving skill selection and package authority. An Agent Skill package
candidate can change only one root agent selection. It changes the selection from no skill to one
exact generated skill and introduces that exact inert package.

Model-authorized evaluation and activation remain unavailable. Agent Skill package installation,
signing, publication, and executable-resource generation remain unavailable. Multi-skill generation
also remains unavailable.

## Non-goals

- Flow does not retain Claude Code plugin compatibility.
- Flow does not provide a general compatibility layer for Claude Code, OMP, and Prime Agent.
- Flow does not fork or rebrand Pi, OMP, or Prime Agent.
- Flow does not reproduce OMP's full tool surface in the initial release.
- Flow does not make Markdown an executable orchestration language.
- Flow does not initially provide distributed or multi-host scheduling.
- Flow does not guarantee exactly-once behavior for arbitrary external side effects.
- Flow does not guarantee prepaid or invoice-authoritative model-cost caps, currency conversion, or distributed quota reservation.
- Flow does not autonomously merge, release, deploy, or weaken its safety floor.
- Flow does not let a model activate an adaptive prompt candidate.
- Flow does not permit live mutation of policy, evaluator definitions, or graph semantics.
- Flow does not make a Python or JavaScript kernel a mandatory core primitive.
- Flow does not treat process or worktree isolation as a security sandbox.
- Flow does not copy, export, merge, or promote changes from an ordinary child workspace; only a
  compiler-generated bounded optimization candidate may use the typed promotion saga.
- Flow does not permit arbitrary dependency cycles, nested or unbounded loops, nested
  optimization, or model-authorized acceptance.

## Architectural litmus tests

Flow is acting as a harness only when:

- Reordering workflow nodes changes execution without prompt changes.
- Removing a required edge cannot be overridden by model prose.
- Restricting a node's tools prevents undeclared calls structurally.
- Restarting after interruption identifies the same next safe node.
- A confident completion narrative cannot pass a failing deterministic check.
- Changing providers does not migrate workflow, run, or evidence schemas.
- Equivalent executions produce equivalent Flow transition ledgers across models.

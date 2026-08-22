# Testing and evaluation

## Quality gate

Run the complete local gate with:

```sh
npm run check
```

It verifies formatting, lint rules, strict TypeScript contracts, all default tests, a clean
production build, and compiled-process tests. The build removes the previous `dist/` tree first so
deleted modules cannot survive into a release artifact.

## Verify a preview package

Use the local package check while you develop release code:

```sh
npm run pack:check
```

This command rebuilds the current checkout and creates an ephemeral archive. It installs the
archive into a clean temporary consumer with lifecycle scripts disabled. The archive includes the
reviewed `npm-shrinkwrap.json`, and the clean install tests the production dependency closure that
npm resolves at that time. The check then runs installed `flow quickstart`, verifies its durable
evidence, checks read-only diagnostics, and opens the accepted run through the explicit browser
command. It doesn't create publication authority.

To prepare a settled release directory from a clean revision, use:

```sh
npm run release:prepare
```

`release/package/` contains one npm archive and `package-release-evidence.json`. The evidence binds
the source revision, package version, SHA-512 archive digest, and exact archive paths, modes, and
byte counts. Installation verification checks the resulting tree, including npm's executable-mode
normalization for the `flow` launcher. A second preparation of the same identity returns the
current artifact. A conflict or uncertain settlement fails without replacing it.

To consume only that settled directory and verify a clean installation, use:

```sh
npm run release:verify
```

The `Preview release` workflow transfers that same directory through GitHub Actions. Ubuntu 24.04
x64 and macOS 15 Intel independently download it. Each host validates the archive and installed
tree, and completes installed `flow quickstart` through the production sandbox. Each host also
verifies the explicit browser path. The workflow generates build provenance only after both hosts
pass. A separate protected job publishes without rebuilding the package.

For publication authority and recovery, read
[Preview release operations](operations/release-preview.md).

## Test layers

| Layer | Purpose | External effects |
| --- | --- | --- |
| Domain unit | Workflow/goal/budget/work-profile/concurrency/config compilation, closed work-profile context, closed typed-result schema and strict JSON/canonicalization bounds, exact condition/guard/join/approval and bounded-loop/optimization expansion validation, child depth/tree/result/wait/budget bounds, persisted result/loop/child/optimization topology, numeric direction and invariant evaluation, delta rehashing, concurrent capacity and dependency replay, declaration-ordered outcomes and failure projection, durable profile default and result/decision/check/promotion/completion/omission/child replay, fresh-recovery policy bounds, monotonic attempt replay, proof-safe interruption eligibility, monotonic capacity merge, admission state-machine exploration, checked resource and UTF-8 artifact aggregation, exhaustion, policy and command/graph approval digests, exact agent-command request/policy/approval/prepare/settlement replay, single-use grant consumption, pure criterion evaluation, and decision/effect/settlement/reconciliation/receipt/approval replay invariants | None |
| Application unit | Typed-result publication and condition/approval/verifier/loop/child/optimization composition, post-admission work-profile context and non-authority, isolated candidate scheduling, accept/reject/stagnation/omission, tree-wide budget reservation/accounting including artifact ceilings and exact child roll-up, cancellation, sibling overlap, terminal and pre-ledger crash recovery, fail-closed missing-workspace recovery, promotion prepare/settlement/cleanup interruption, typed promotion reconciliation without reapply, unknown-state blocking, quiescent-wave admission and bounded artifact overshoot, overlap bounds, reverse completion with declaration order, selected-branch and loop-body concurrency, sequential iteration barriers, command and evidence-bound approval/control barriers, cancellation and failure quiescence, settlement-ceiling precedence, scheduler ordering, omission propagation, serialized write-ahead effect and agent-command publication, command-output settlement accounting, ordered multi-attempt recovery observation/disposition, crash boundaries around result/loop/approval transitions and the resume marker, partial reconciliation progress, recovery compatibility, budget stop boundaries and timeout clamping, approval waits and expiry, completed-node skipping, failure propagation, and executor authority | Test-only in-memory ports |
| Presentation unit | Strict document bounds, deterministic public projection, terminal-safe text, cursor replay, steering identity, renderer lifecycle, and primary/cleanup failure precedence | Injected event, control, and terminal ports; no process terminal |
| Source dependency contract | Application modules import application ports and domain contracts but no infrastructure implementation | Repository source scan; no external effects |
| Infrastructure integration | Same-policy concurrent SRT session reference counting, cancellable cross-workspace session serialization, portable reflink-or-copy child snapshots with protected-path exclusion and manifest-bound recovery, bounded candidate capture, additions/modifications/deletions/modes/directories/symlinks, stale affected-path and removed-directory-closure refusal, write-ahead promotion and rollback blobs, live compensation, durable-temporary/applied-step/local-commit crash reconciliation, hostile-divergence classification, mutually waiting production command branches, atomic hash-anchored edits, chunk-bounded no-follow effect observation under target growth, portable non-regular and missing-ancestry classification, shared edit/reconciliation target coordination, real JSONL effect-journal reopening and fresh-attempt continuation, same-host edit-lock recovery, exact-byte versions, protected paths, process and approval-decision ownership, immutable atomic agent-command decision sidecars, attached/detached live grant consumption, attached live denial without preparation or spawn, strict project/operator config, owner-only supervisor records, typed detached recovery refusal/success, atomic claims and command journals, admission replay/compaction, torn-tail repair, and real child processes | Temporary directories and local processes |
| CLI integration | Init, config inspection, validate, run, work-profile selection/conflict/public output, typed-result publication/inspection, attached/detached artifact-budget exhaustion and inspection, attached and detached child ledgers/workspaces, detached accepted/queued/rejected submission, events, terminal presentation, active/queued cancel, supervisor status/shutdown, wait, approve/deny, exhaust, committed-boundary resume, proof-safe fresh resume, persist, and inspect through production composition | Temporary run ledgers, private local sockets, and local processes |
| Compiled-process integration | Direct-entry signal handling, Linux x64 pseudo-terminal startup and restoration, local browser presentation delivery, process-group termination, edit crashes before rename, after rename, after directory sync, on settlement rejection, and after settlement persistence, cross-process run claiming, live agent-command denial from a separate CLI process, detached client exit with exact work-profile replay, bounded concurrent admission, queued cancellation without execution, policy mismatch/rebinding, supervisor restart/adoption, and real sandbox boundaries | Built CLI, temporary run ledgers, pseudo-terminals, local process groups, native sandbox primitives, Unix sockets, and loopback networking |
| Browser presentation | Fragment removal, tab-scoped capability retention for reload, terminal capability removal, capability authentication, fixed-resource policy, complete-document streaming and reload, keyboard steering, storage denial, text-only DOM insertion, attributed package notes, responsive layout, focus visibility, and console/network closure | Pinned Playwright Chromium, explicit loopback listener, and 1280×720, 768×1024, and 375×812 viewports |
| Pi adapter contract | Exact model/tool request translation, fixed bounded work-profile rendering, explicit zero turn/provider retries, versioned workspace and immutable `skill://` reads, selected package/read receipts, edit receipts, argv-only command authorization/journaling and shared sandbox delegation, bounded approval-denial propagation, session-stat usage translation, policy-broker routing, setup races, timeout settlement, and committed/uncertain error classification | Temporary workspace and test-only runner at the SDK seam |
| Pi SDK integration | Real `ModelRuntime` and `createAgentSession` composition, `flow_read`/`flow_edit` tool turns, production tool-error conversion back into the next model turn, and streaming | Deterministic in-process provider; no network or credentials |
| Live Pi | Provider authentication, streaming, cancellation, and model compatibility | Opt-in network and provider cost |

The agent-command matrix uses the real router, Pi executor, durable recorder, command executor, and
JSONL store around deterministic model and sandbox seams. It covers attached execution in an
isolated child, exact parent and child inspection, authenticated detached-worker execution,
write-ahead preparation/settlement, retained-prefix integrity, sandbox provenance, nonzero results,
artifact exhaustion, cancellation, preparation-inclusive deadlines that do not trust cooperative
sandbox cancellation, an absolute pre-spawn deadline after event-loop blocking, pre-spawn refusal of
process-group-only agent containment, verified Linux SRT PID-namespace descriptors, and SIGKILL
escalation for a SIGTERM-resistant same-group descendant. It also rejects a workspace-controlled
Bubblewrap earlier in `PATH`, substituted outer launchers, shell operators, and lifecycle-looking
option values; preserves unconfirmed termination when sandbox cleanup fails too; and proves that an
unconfirmed settlement aborts the model attempt, rejects later durable command preparation, and
cannot replay as terminal success.

Test doubles are permitted only in tests at explicit ports. Production modules contain no mock executor, fake provider, fallback success, or sample result.

## Runtime smoke test

After `npm run build`:

```sh
node dist/cli/main.js --help
node dist/cli/main.js init .
node dist/cli/main.js config show
mkdir -p .flow/skills
cp -R examples/agent-skills/review .flow/skills/
node dist/cli/main.js skills validate
node dist/cli/main.js skills list
node dist/cli/main.js skills inspect review
node dist/cli/main.js validate examples/portable-agent-skill.workflow.yaml
mkdir -p .flow/verifiers
cp -R examples/verifier-packages/release-tests .flow/verifiers/
node dist/cli/main.js verifiers validate
node dist/cli/main.js verifiers list
node dist/cli/main.js verifiers inspect release-tests
node dist/cli/main.js validate examples/versioned-verifier-package.workflow.yaml
node dist/cli/main.js run examples/versioned-verifier-package.workflow.yaml --run-id package-smoke
node dist/cli/main.js inspect package-smoke
node dist/cli/main.js packages pack examples/capability-bundle-source --output /tmp/review-suite.flowpkg
node dist/cli/main.js packages list
node dist/cli/main.js packages verify
node dist/cli/main.js validate examples/agent-command-approval.workflow.yaml
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id smoke
node dist/cli/main.js inspect smoke
node dist/cli/main.js web smoke --actor local:smoke
node dist/cli/main.js run examples/budgeted-foundation.workflow.yaml --run-id budget-smoke
node dist/cli/main.js inspect budget-smoke
node dist/cli/main.js validate examples/conditional-branch.workflow.yaml
node dist/cli/main.js run examples/conditional-branch.workflow.yaml --run-id conditional-smoke
node dist/cli/main.js inspect conditional-smoke
node dist/cli/main.js run examples/concurrent-fork.workflow.yaml --run-id concurrent-smoke
node dist/cli/main.js inspect concurrent-smoke
node dist/cli/main.js run examples/bounded-loop.workflow.yaml --run-id loop-smoke
node dist/cli/main.js inspect loop-smoke
node dist/cli/main.js run examples/bounded-optimization.workflow.yaml --run-id optimization-smoke
node dist/cli/main.js inspect optimization-smoke
node dist/cli/main.js run examples/typed-result.workflow.yaml --run-id result-smoke
node dist/cli/main.js inspect result-smoke
node dist/cli/main.js run examples/isolated-child.workflow.yaml --run-id child-smoke
node dist/cli/main.js inspect child-smoke
node dist/cli/main.js run examples/approval-gated-command.workflow.yaml --run-id approval-smoke
node dist/cli/main.js approve approval-smoke approval-2 --actor local:smoke
node dist/cli/main.js resume examples/approval-gated-command.workflow.yaml --run-id approval-smoke
node dist/cli/main.js run examples/evidence-approval.workflow.yaml --run-id review-smoke
node dist/cli/main.js approve review-smoke approval-4 --actor local:smoke
node dist/cli/main.js resume examples/evidence-approval.workflow.yaml --run-id review-smoke
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --detach --run-id detached-smoke
node dist/cli/main.js events detached-smoke --after 0 --follow
node dist/cli/main.js supervisor status
node dist/cli/main.js supervisor shutdown
```

`npm run test:browser` starts pinned Chromium and the real loopback host. It checks that all requests
remain same-origin. It renders all six closed components without markup execution. It checks
keyboard actions, complete-document reload, tab-scoped capability retention during observation, and
capability removal after terminal observation. It also checks horizontal layout at the three
documented viewports.

The compiled-process suite authenticates to `flow web` from `dist`. The package verifier repeats
that trace through the installed binary.

The credential-free smoke commands validate, list, and inspect the portable package without loading
its private body into listing output. Running `examples/portable-agent-skill.workflow.yaml` requires
a configured model provider. Focused capability tests prove strict discovery, traversal/symlink and
special-file refusal, source-race detection, canonical size/digest bounds, progressive UTF-8 reads,
metadata-only prompt assembly, permission non-escalation, attached/detached/child/recovery snapshot
identity, and forged selection/read refusal.

The credential-free versioned verifier-package smoke run snapshots an exact local manifest and
executes its argv-only definition through the production sandboxed command-verifier path. Focused
tests prove strict SemVer and manifest parsing, inert manifest-only directories, symlink and source
race refusal, aggregate bounds, exact version/kind binding, command/model driver reuse, redacted
metadata operations, requirement/snapshot/control-graph/evidence replay reconciliation, live-source
drift immunity, and attached, detached, child, and recovery transport. Those ABI-specific tests do
not by themselves claim remote installation, arbitrary evaluator-code isolation, provider
correctness, or model-rubric safety; the bundle-distribution suite separately covers installation.

The credential-free command-tool smoke path installs
`examples/tool-packages/git-status/TOOL.yaml`, runs `flow tools validate`, lists metadata, inspects
the exact version, and validates `examples/versioned-command-tool.workflow.yaml` without invoking a
model or command. Focused tests prove strict manifest and scalar-input contracts, literal argv
rendering, no-follow discovery and drift refusal, exact workflow binding and name-collision checks,
Pi custom-tool translation, shared call caps, policy/approval/sandbox/journal reuse, durable sourced
request reconciliation, metadata-only CLI behavior, attached execution, detached live-source drift
immunity, child subset binding, and recovery from the durable snapshot alone. A real in-process Pi
session also discovers a local package, calls it from a package-only agent, obtains required live
approval, settles the command, publishes a typed result, and replays the ledger. Adversarial tests
reject interpreter/dispatcher/path identities, unsafe profile argument roles, runtime-envelope
overflow, reordered input-digest ambiguity, and forged raw-exec authority. Those tool-ABI tests do
not by themselves claim remote acquisition, arbitrary executable package-code containment, command
correctness, provider correctness, macOS agent-command support, or hostile-workload isolation; the
bundle-distribution suite separately covers acquisition of the inert ABI.

The credential-free workflow-package smoke path installs
`examples/workflow-packages/release-check/WORKFLOW.yaml`, runs `flow workflows validate`, lists and
inspects exact metadata, validates `examples/versioned-workflow-package.workflow.yaml`, and validates
or runs the packaged root locator `workflow:release-check@1.0.0`. Focused tests prove strict YAML and
SemVer bounds, no-follow discovery and source-race refusal, local/installed collision handling,
transitive snapshot capture, cycle/depth failure, unchanged inline digests, ordinary child
compilation, typed package requirements and control-graph reconciliation, attached and detached
execution, live-catalog removal immunity, and snapshot-only resume/replay. These tests do not claim
template parameters, version solving, executable extension containment, unrestricted UI
extensions, or benchmark superiority. The A2UI-profile presentation package suite has a separate
focused contract. It covers the layout-only v1 catalog and bounded attributed-content v2 catalog.
Policy packages also have a separate focused suite.

Presentation-package tests bind catalog-v1 digest compatibility and catalog-v2 static-note limits.
They validate both catalogs through the frozen official A2UI v0.9 envelope. Projection tests prove
fixed attribution and unchanged run, action, truncation, and layout authority. Terminal and browser
tests render markup-looking note text literally. Browser screenshots cover desktop, tablet, and
mobile layouts. ACP tests prove byte-equivalent plan, status, and permission output when the public
document also contains the package-note section.

The bundle-distribution suite proves deterministic packing, strict content parsing,
public-HTTPS-only digest-before-parse acquisition, DNS rebinding defenses, redirect refusal,
pre-abort and in-flight DNS cancellation, content-addressed activation, parent-synced store
creation, crash-boundary commit-uncertain reporting, fail-closed stale locks, collision handling,
bounded source traversal/read races, local inspection and removal, installed-catalog composition,
and network-free recovery. It does not claim publisher identity or safe executable package
payloads. The signed-OCI suite separately proves publisher identity.

The capability-metadata suite proves strict canonical metadata and exact offline signature input.
It proves local-clock expiry, revocation, exact target binding, and monotonic rollback refusal. It
also proves atomic publication, shared mutation ownership, an authenticated empty deny-all target
set, remediation, and immutable admitted snapshots.

The signed-channel selectors prove canonical public HTTPS admission, DNS pinning, redirect refusal,
and one total deadline. They prove exact media type and envelope bounds. They also prove candidate
identity, capacity, tamper checks, explicit review, and fresh activation. No check mutates a package
or run. The CLI composition test spans check, list, inspect, inactive-state proof, activation,
removal, and retained active state across separate invocations.

The capability-repository suite proves explicit local-root initialization and sequential
dual-authorized rotation. It covers threshold failure, role expiry, rollback, freeze, and
mix-and-match rejection. It proves consistent target URLs and bounded delegation cycles, depth,
and fan-out. It also covers atomic generations, offline candidate activation, cancellation,
concurrency, and fixed public output.

The replacement suite also proves semantic version ordering and capability-surface continuity. It
covers two-target metadata, policy rejection, old-or-new readers, retained prior content,
cancellation, settlement, repeat, and content-free CLI output.

The package-maintenance suite proves deterministic preview, exact plan apply, and drift refusal. It
also proves physical publication ceilings, recovery scan ceilings, and fail-closed handling of
links, special entries, missing active blobs, and inconsistent content. Reader races
prove that an open old generation remains complete after unlink and that a pre-open race retries
the new generation once. Cancellation tests distinguish no-mutation cancellation from post-unlink
directory settlement, partial progress, idempotent retry, and settlement uncertainty. CLI tests
prove content-free aggregate output and exact grammar.

A fixture comes from the independent `theupdateframework/tuf-conformance` repository. It proves
delegated-target interoperability through Flow's production staging adapter. The runtime-isolation
test places a failing repository-state tripwire beside the package store.

That test proves that an attached run retains the old snapshot across an active replacement. A
later admission receives only the new digest. A detached worker executes the old frozen snapshot
while live package metadata is unreadable. The test prunes the retired live-store blob before the
detached and resumed paths. Inspect and resume remain snapshot-only because they use the immutable
run snapshot instead of the live package store.

The scheduler unit suite proves a full interval after every settled check. It proves no overlap,
no catch-up burst, observable startup and restart gaps, missed-interval counting, consecutive
outage status, and exact cancellation. It also proves in-process and cross-restart clock-rollback
stop behavior.
Watcher tests prove exact installed-package and publisher binding, patch and minor policy, stable
highest-version choice, check-only retry, replacement-failure stop, fixed status, and one
project-local owner. CLI integration performs one real TUF check and offline atomic replacement.
First-activation tests prove exact grammar, full waits, finite exhaustion, conflict-before-check,
and deterministic exact selection. They prove inert non-policy admission, active-metadata enforcement, durable
waiting/prepared/settled recovery, and exact and excessive record bounds. They also prove
settlement reconciliation and terminal no-reinstall behavior. CLI integration performs a real TUF
check, offline Sigstore reopen, and metadata-required first installation.
Frozen attached, detached, child, recovery, replay, and evaluation snapshots remain unchanged.
The suite does not claim a trustworthy host clock or private repository credentials. It also does
not claim major or policy-package replacement, rollback,
background blob collection, or online trust-root refresh.

Validating `examples/agent-command-approval.workflow.yaml` is credential-free. Running it requires
a configured model provider and a second local client to approve or deny each exact `flow_exec`
request while the attached process or detached worker stays alive. Focused and compiled-process
tests drive approval and denial through separate CLI processes, prove that denial records actor and
reason without command preparation or spawn, and use the real pinned Pi `createAgentSession` loop with a deterministic
in-process provider to prove the bounded denial becomes an error tool result visible to the next
model turn. Real-channel integration distinguishes invalid receipt auditing from retryable transport
unavailability. Cancellation/decision races, expiry, single-use consumption, concurrent-agent queuing,
oversized or non-regular sidecars, replay tampering, and owner loss are covered independently.

The remaining examples use the real argv-only command executor through the production sandbox, accept declared goals from legacy command and first-class typed command-verifier evidence, publish strict canonical typed results, execute independently-ledgered isolated children, promote one bounded optimization candidate, exercise durable resource inspection and exact loop convergence, and require no model credentials. Focused child and optimization tests prove recursive contract bounds, deterministic linkage, typed composition, numeric direction and invariants, complete delta evidence, independent metadata/content/entry ceilings, idempotent capture reopening, stale-parent refusal, write-ahead promotion and compensation, tree-wide accounting, boundary cancellation without later evaluation or promotion, concurrency, crash recovery without reapply, protected-state exclusion, snapshot fidelity, replay mutation resistance, and cleanup. Focused result tests prove duplicate-key/I-JSON refusal, closed schema and complexity bounds, RFC 8785 canonicalization, resource neutrality, branch/approval/verifier/loop composition, recovery idempotence, and replay mutation resistance. Focused verifier tests use deterministic fake runners to prove exact durable input binding, zero-tool model invocation, strict verdict parsing, aggregate bounds, branch/approval/loop composition, cancellation precedence, budget narrowing, replay mutation resistance, and refusal to repeat an open attempt. Attached CLI and detached-worker integration preserve typed results, child histories, optimization evidence, promoted parent files, and verifier evidence through real JSONL stores. The bounded-loop example records one continue, one stop, unused-iteration omission, final verification, and cleanup; the optimization example records one accepted promotion, one equal rejection, stagnation, and cleanup. The ordinary concurrent CLI test makes two same-workspace SRT-contained commands wait for each other's workspace marker, so it fails under accidental same-session serialization; incompatible child-workspace SRT command phases are intentionally queued across session reset. Default integration tests also reopen interrupted agent attempts from real JSONL: applied edits remain blocked, while read-only or not-applied edit attempts with an explicit policy continue at the exact next attempt in both attached CLI and detached-worker paths. The tests prove repeated recovery cannot duplicate reconciliation, result publication, loop transitions, child import, candidate capture, candidate promotion, or interruption disposition. `npm run test:runtime` additionally spawns compiled children and exits writable workers at five deterministic edit boundaries—before rename, after rename, after a real directory sync, when settlement append rejects, and after settlement persistence—to verify ledger/file truth. It also delivers `SIGINT`, proves its POSIX command process group terminates, verifies the forced-exit guard for leaked provider handles, races separate processes for one run identifier, and attacks the real filesystem, environment, run-store, and loopback-network boundary. These tests do not simulate host reboot or power loss. The package supports ordinary command nodes on Linux and macOS. Agent-issued commands execute only on Linux after verified PID-namespace preparation; macOS refuses them before spawn. Windows command nodes fail before spawn because descendant containment is not yet implemented.

Focused artifact-budget tests prove multibyte UTF-8 accounting for successful and failed command,
agent, verifier, and child evidence; equality and bounded concurrency-wave overshoot; legacy child
replay; recovery identity; fresh-retry neutrality before terminal evidence; attached inspection;
and detached-worker transport. Separate retained-artifact tests prove content and producer digests,
bounded previews, content-free catalog listing, same-run policy reads, exact byte windows, and
opened-inode checks. They prove crash-left blob settlement, immutable replay references,
inspection, shared retention, exact catalog bounds, and fixed lock-settlement errors. They also prove
the exact 1 MiB command-capture boundary across multiple chunks, orphan plans, stale-plan rejection,
and exact-plan pruning. The tests don't claim a project disk quota.

The evidence-approval example and focused tests prove exact graph request, approve, deny, omission,
crash repair, quiescent concurrency, bounded-loop, budget, goal, and detached-worker behavior.

The compiled-process suite also proves that a detached worker outlives its client, that public
cancellation terminates the real descendant process group and records attribution, and that a new
supervisor generation authenticates and adopts a still-running worker exactly once. Concurrent
compiled clients are required to converge on one auto-started generation and remain within active
and queue bounds. The suite distinguishes accepted, queued, and queue-full responses, proves queued
cancellation creates no run ledger, and exercises policy mismatch plus explicit idle rebinding.
Protocol tests exercise v2 bounded framing and strict schemas; admission tests explore reachable
states and FIFO invariants; store tests exercise owner-only permissions, no-follow reads, immutable
snapshots, automatic replay-equivalent compaction, startup serialization, atomic claims, and durable
cancellation records.

Runtime sandbox tests require the host capabilities listed in the README. A sandbox dependency warning is a test failure, not a skip. Running Flow's sandbox suite from inside another restrictive sandbox can prevent SRT from creating its internal Unix socket or namespace; run the suite directly on the host or in a CI runner configured for nested containment. This operational accommodation must not weaken the production profile.

The container command profile has separate unit, integration, and real-engine evidence. Unit tests
bind operator-only selection, exact Docker configuration, currentness, durable ownership, and
lost-create reconciliation. They also bind later orphan scans, foreign-object refusal, cancellation,
and two-attempt cleanup.

Structured execution tests bind attach-before-start, multiplexed task output, fixed control stages,
command-owned wait cancellation, and task exit status. They also bind same-process settlement after
preparation and lease cleanup failures. Workspace tests bind bounded sensitive-entry discovery and
Git read-only mapping. They also bind bounded content snapshots, pre-launch snapshot drift
rejection, and the complete public configuration digest.

Integration tests bind the backend-neutral executor and offline inspection contracts.

The pinned Linux x64 release gate uses
`test/runtime/container-command-sandbox.runtime.test.ts` and
`test/runtime/container-command-recovery.runtime.test.ts`. These tests use the prepared Prime image
and the real Docker API. They must prove workspace mutation, protected-state denial, credential
denial, sensitive-file masking, and read-only Git access. They must also prove external-route
denial, host-loopback denial, undeclared host Unix-socket isolation, and exact resource controls.
They must also prove that local TCP and Unix-socket binding fail inside the container namespace.

The process-control check binds the container cgroup limit. It does not require `RLIMIT_NPROC`,
which Linux accounts across unrelated processes that share the host operator UID.

They must prove timeout and operator-cancellation settlement, descendant termination, full-ID cleanup,
process-restart recovery, and pre-launch disappearance refusal. The descendant gate issues its
survival challenge only after confirmed cleanup. It does not infer cleanup from the relative order
of independently scheduled host and container timers. Portable recovery tests prove foreign-object
safety.

The compiled-process run-identifier gate holds the winning run at its existing approval boundary.
It proves one public creation and one fixed conflict without making command-sandbox success part of
the ownership oracle.

A missing Docker prerequisite fails the dedicated runner. The gate does not skip or weaken the
production policy.

## Live Pi test policy

Live tests are opt-in and excluded from `npm test`. Run them with both `FLOW_LIVE_PI_PROVIDER` and
`FLOW_LIVE_PI_MODEL`. The live suite reports an explicit skip when a setting or configured
authentication is absent. It uses no hidden fallback. It fails when the selected model is invalid.
It also fails when configured authentication is invalid or the provider call fails. Unit and
integration tests do not consume provider credentials. Provider-cost assertions use deterministic
session-stat fakes. No local test claims correspondence with an external invoice.

`test/live/quickstart-coding.live.test.ts` requires the `anthropic` or `openai` preview provider.
It runs the public coding quick start in a fresh empty directory. It requires a committed edit
receipt and accepted deterministic verifier evidence.

The deterministic CLI integration uses the production Pi session and Flow tools. A local test
provider supplies the model stream. Default CI can therefore prove the policy and effect path
without network access or provider cost.

## Product evaluation

Flow now has a provider-neutral evaluation layer for reproducible paired harness comparisons. The
example at `examples/evaluation/harness-comparison.evaluation.yaml` validates without credentials;
running it requires the declared provider. Focused tests cover strict plan parsing, portable source
identity, profile/control drift, deterministic alternating schedules, fresh workspace isolation,
private verifier non-disclosure, terminal failure recording, metric availability, scheduled
denominators, deterministic heterogeneous bootstrap output, safety constraints, single-writer
ownership, torn-tail repair, tamper/relabel/intermediate-symlink attacks, fatal UTF-8 rejection,
resume from the exact committed suffix, and semantically identical offline inspect/export evidence.
Verifier tests include wrong re-digested identities, contradictory assertion outcomes, and
actionable error reasons; comparison tests include holdout partitioning, environment mismatch,
incomplete safety evidence, and constraint/verdict gates.
Adapter telemetry tests also execute a child-only profile and require unprojected child activity,
policy, intervention, and recovery measurements to remain unavailable.

Native Pi tests cover the strict profile identity, registry drift, signed protocol, frame limits,
durable adapter starts, cancellation, and process-tree termination. They also cover cumulative
model token and cost limits. Registry tests change an installed dependency after admission. Runtime
tests cover a blocked inference call, a total standard-error overflow, and Linux-only containment.

Native OMP tests cover strict profile identity, Bun release attestation, execute permission,
installed dependency drift, and dependency-resolution drift. They also cover the signed protocol,
the host inference bridge, tool confinement, and honest metrics. Credential-free tests run the real
OMP session through a fake host broker. Linux runtime tests deny OMP access to project state,
evaluation state, and sibling workspaces.

Credential-free integration tests run the real Pi SDK through a fake host broker. Native runtime
tests run the compiled driver through SRT. They deny access to project state, evaluation state,
sibling workspaces, and process control input.

The external CLI test runs a paired Flow and native Pi plan. It then inspects and exports the
evidence without a live runtime. A separate import test stores Pi and OMP evidence. It blocks the
production runtime and both OMP packages. It proves that offline inspection and export do not load
them. The CLI test also protects the
configured project `.flow` directory when the plan is in a different directory. It rejects
prompt-tuning export for the external profile.

Adaptation tests cover tuning-only projection, packet digests, omitted private fields, contradictory
records, incomplete pairs, export limits, bounded errors, and impossible schedules. Candidate tests
cover strict schemas, prompt whitespace, stale identities, unrelated evidence, invalid targets,
source limits, zero-tool model generation, exact output limits, and generation provenance.

Filesystem tests cover no-follow reads, root and ancestor races, path escape, invalid UTF-8, and
malformed evidence. Generation tests also cover source drift, output collision, temporary-file
limits, interrupted publication, private-data omission, and no automatic activation. Plan tests
cover exact baseline binding, generated-source provenance, legacy resume, and durable identity
tampering.

Registry tests cover canonical digest references and strict OCI manifests. They cover public DNS
pinning, anonymous compatibility, exact private Basic token exchange, and pull-scope validation.
They also cover token-host isolation, safe blob redirects, limits, cancellation, buffer cleanup,
offline Sigstore verification, and exact publisher policy.

CLI integration covers
paired flags, invalid usernames, bounded injected secret input, credential-free durable provenance,
atomic publication, and offline package use. These tests use synthetic registry responses and
private canaries. They do not contact a live registry, signature service, or trust-root service.

Activation tests cover complete superior admission, incomplete evaluations, losing evaluations, exact profile identity, and source drift.
They also cover proposal drift, version conflicts, concurrent writers, and rollback.
Store tests cover candidate artifacts, baseline artifacts, linked paths, invalid UTF-8, changed blobs, and rollback target checks.
They cover publication cleanup, uncertain commits, dead-lock recovery, and empty or partial lock recovery.
They cover pre-link, post-link, and maximum-source blob recovery.
They reject 129 index, lock, or blob temporary files.
They reject aggregate temporary bytes above each index and blob limit.
They reject a blob temporary file that is one byte above its per-file limit.
They also cover history tampering, source bounds, resource bounds, transition limits, and unknown rollback targets.

Effective-harness tests evaluate complete before and after states. They do not evaluate isolated
surface deltas. They cover both composition orders and exact current-head revalidation. Store tests
cover publication order, exact retry settlement, retained-state rollback, and project-scope binding.
They also cover ancestor links, source replacement, cancellation, and content-free public views.

Model-routing tests bind one existing root agent before and after tuple. They reject no-op routes,
non-root targets, unrelated workflow changes, source races, links, stale heads, route substitution,
and direct activation without composition. Paired-plan tests require ordered profile routes and
shared non-route controls. Runtime tests observe the selected route in attached recovery and a
detached worker without live candidate sources. CLI tests cover offline inspection, export,
activation, public-output privacy, and state-digest rollback.

Child-specialist tests bind one embedded child node and one child agent. They also bind the complete
parent and child workflow identities and the immutable package-closure digest. The tests cover exact
instructions and skill-selection bounds, no-op and multi-axis rejection, and undeclared skills.
They cover stable no-follow source admission, source races, and cancellation precedence. They also
cover complete-state composition, paired durable evidence, activation, rollback, attached child
execution, live-source removal, and content-free public output.

Supplemental-memory tests bind one stable entry to one exact root or embedded-child agent. They
cover add, replace, remove, stale entry identity, no-op rejection, canonical order, duplicate
identity, malformed UTF-8, and exact entry, target, state, count, and candidate-source bounds. Local
admission tests cover direct and ancestor links, same-size source replacement, cancellation
precedence, and value-free failures. Composition and activation tests preserve every unrelated
memory entry, workflow field, and package. Runtime tests prove targeted prompt placement, untargeted
isolation, content-free public output, attached recovery after live-store removal, and detached
execution from the frozen snapshot.

Generation tests add root and embedded-child targeting, exact add and replacement preconditions,
one strict value-only response, and one exact-model zero-tool turn. They bind input, response,
token, evidence, and memory bounds. They also cover source and active-head drift, cancellation,
no-replace publication, content-free public views, and durable generated provenance.

Runtime tests remove the live effective store. They exercise attached resume, detached worker
execution, and child capability binding. They also cover replay and current-policy rejection from
the frozen snapshot.

Run tests cover durable activation replay, source loss, live-head changes, detached execution, and resume.
Detached admission tests reject activation locators with missing evidence or changed source bytes.
Model-context tests reject candidate, evaluation, activation, and source data in the model system prompt.
Policy and sandbox tests deny direct reads of Flow and protected run state.
Runtime tests use nested root and child execution directories.
They deny reads of the canonical project `.flow` directory, activation state, and a sibling run ledger.
They deny child reads from sibling workspaces in the nearest and outer private collections.
They deny a root command that tries to create a named or historical private collection.
They also deny reads and prevent host changes for each existing collection inside a broad execution root.
On Linux, a protected write call can succeed in an ephemeral mask. The runtime tests prove that the
host path does not change. On macOS, the same call fails.
Sandbox unit tests bind each discovered collection to a literal protected path and its descendants.
They prove that Linux uses the explicit project root and does not treat a custom `.flow` run store
as a project root.
Workspace tests cover deep run-store paths, explicit project-root routing, planted collection links,
nested legacy source translation, candidate capture and promotion after relocation, and legacy
relocation before recovery activity. They cover a bounded and verified cross-filesystem staging
copy. They also reopen one workspace through two filesystem aliases for the same run store. Replay
tests bind the old and new child paths to one `run_resumed.workspaceRelocation` event
and reject relocation for a root run. A three-level test records each relocation before grandchild
command recovery. Detached tests bind the configured project root to the command, job, worker, and
digest. They also recover an old job that has no project-root or protected-path fields.

The CLI integration covers model generation, tuning export, candidate evaluation, activation
preview, exact apply, active execution, inspect, source removal, and baseline rollback. It proves
that a new run uses the stored baseline artifact after rollback. It also proves that the baseline
file remains unchanged. These tests do not claim candidate superiority.

The Agent Skill candidate integrations generate and validate one bounded candidate. They prove one
zero-tool model turn, exact workflow/package/evidence/target admission, source revalidation, atomic
publication, and private-resource omission. The paired evaluation admits immutable baseline and
projected package snapshots and executes the same workflow with both snapshots. The tests also
reopen public evidence after removal of the live candidate and skill directory. Generation grants
no activation or package authority.

`test/integration/cli/prompt-candidate-generation.test.ts` covers the zero-tool generation path.
`test/integration/cli/prompt-candidate.test.ts` covers the complete evaluation and activation path.
`test/integration/cli/prompt-activation.test.ts` covers durable active-run and resume behavior.
`test/integration/cli/agent-skill-candidate-generation.test.ts` covers the selected-resource
generation and public-output path.
`test/integration/cli/agent-skill-candidate.test.ts` covers the Agent Skill validation, paired
execution, activation, rollback, recovery, privacy, and offline-inspection path.
`test/integration/cli/agent-skill-package-candidate-generation.test.ts` covers the A2-D review
directory end to end. It proves one zero-tool content-only generation, exact published bytes, and
content-free public output. It also proves read-only validation and paired no-package/package
evaluation. The test then covers explicit activation, source deletion, offline active execution,
rollback to no package, and grammar isolation from the two older generation modes.

The production CLI integration runs the complete composition with a deterministic fake executor, so
unit and integration suites need no provider credentials or network. Live provider comparisons are
operator-run evidence and are not part of `npm test`.

Compare Flow with the legacy plugin on held-out repository tasks by using equivalent model,
thinking, budget, retry, network, fixture, verifier, seed, and order settings. A benchmark records
verified task success, false completion, cost, context volume, turns, tool failures, duration, human
intervention, policy violations, and recovery behavior when those metrics are available. Missing
records remain in the denominator and unavailable telemetry is never imputed as zero. Cost per
accepted result is emitted only from a complete profile schedule with cost available for every trial
and uses verifier-accepted results as its denominator.

Deterministic held-out checks are preferred. An LLM judge may supplement evidence but cannot override a failing command or missing artifact. Claims that the standalone harness beats the plugin require recorded benchmark results rather than architectural inference.

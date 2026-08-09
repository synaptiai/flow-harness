# Testing and evaluation

## Quality gate

Run the complete local gate with:

```sh
npm run check
```

It verifies formatting, lint rules, strict TypeScript contracts, all default tests, a clean production build, and compiled-process tests. The build removes the previous `dist/` tree first so deleted modules cannot survive into a release artifact. Packaging is checked separately with `npm run pack:check`; that command rebuilds, packs the archive, installs it into a clean temporary consumer with lifecycle scripts disabled, runs the installed CLI, initializes a project, and inspects the effective default configuration.

## Test layers

| Layer | Purpose | External effects |
| --- | --- | --- |
| Domain unit | Workflow/goal/budget/concurrency/config compilation, closed typed-result schema and strict JSON/canonicalization bounds, exact condition/guard/join/approval and bounded-loop/optimization expansion validation, child depth/tree/result/wait/budget bounds, persisted result/loop/child/optimization topology, numeric direction and invariant evaluation, delta rehashing, concurrent capacity and dependency replay, declaration-ordered outcomes and failure projection, durable result/decision/check/promotion/completion/omission/child replay, fresh-recovery policy bounds, monotonic attempt replay, proof-safe interruption eligibility, monotonic capacity merge, admission state-machine exploration, checked resource and UTF-8 artifact aggregation, exhaustion, policy and command/graph approval digests, exact agent-command request/policy/approval/prepare/settlement replay, single-use grant consumption, pure criterion evaluation, and decision/effect/settlement/reconciliation/receipt/approval replay invariants | None |
| Application unit | Typed-result publication and condition/approval/verifier/loop/child/optimization composition, isolated candidate scheduling, accept/reject/stagnation/omission, tree-wide budget reservation/accounting including artifact ceilings and exact child roll-up, cancellation, sibling overlap, terminal and pre-ledger crash recovery, fail-closed missing-workspace recovery, promotion prepare/settlement/cleanup interruption, typed promotion reconciliation without reapply, unknown-state blocking, quiescent-wave admission and bounded artifact overshoot, overlap bounds, reverse completion with declaration order, selected-branch and loop-body concurrency, sequential iteration barriers, command and evidence-bound approval/control barriers, cancellation and failure quiescence, settlement-ceiling precedence, scheduler ordering, omission propagation, serialized write-ahead effect and agent-command publication, command-output settlement accounting, ordered multi-attempt recovery observation/disposition, crash boundaries around result/loop/approval transitions and the resume marker, partial reconciliation progress, recovery compatibility, budget stop boundaries and timeout clamping, approval waits and expiry, completed-node skipping, failure propagation, and executor authority | Test-only in-memory ports |
| Infrastructure integration | Same-policy concurrent SRT session reference counting, cancellable cross-workspace session serialization, portable reflink-or-copy child snapshots with protected-path exclusion and manifest-bound recovery, bounded candidate capture, additions/modifications/deletions/modes/directories/symlinks, stale affected-path and removed-directory-closure refusal, write-ahead promotion and rollback blobs, live compensation, durable-temporary/applied-step/local-commit crash reconciliation, hostile-divergence classification, mutually waiting production command branches, atomic hash-anchored edits, chunk-bounded no-follow effect observation under target growth, portable non-regular and missing-ancestry classification, shared edit/reconciliation target coordination, real JSONL effect-journal reopening and fresh-attempt continuation, same-host edit-lock recovery, exact-byte versions, protected paths, process and approval-decision ownership, immutable atomic agent-command decision sidecars, attached/detached live grant consumption, attached live denial without preparation or spawn, strict project/operator config, owner-only supervisor records, typed detached recovery refusal/success, atomic claims and command journals, admission replay/compaction, torn-tail repair, and real child processes | Temporary directories and local processes |
| CLI integration | Init, config inspection, validate, run, typed-result publication/inspection, attached/detached artifact-budget exhaustion and inspection, attached and detached child ledgers/workspaces, detached accepted/queued/rejected submission, events, active/queued cancel, supervisor status/shutdown, wait, approve/deny, exhaust, committed-boundary resume, proof-safe fresh resume, persist, and inspect through production composition | Temporary run ledgers, private local sockets, and local processes |
| Compiled-process integration | Direct-entry signal handling, process-group termination, edit crashes before rename, after rename, after directory sync, on settlement rejection, and after settlement persistence, cross-process run claiming, live agent-command denial from a separate CLI process, detached client exit, bounded concurrent admission, queued cancellation without execution, policy mismatch/rebinding, supervisor restart/adoption, and real sandbox boundaries | Built CLI, temporary run ledgers, local process groups, native sandbox primitives, Unix sockets, and loopback networking |
| Pi adapter contract | Exact model/tool request translation, explicit zero turn/provider retries, versioned workspace and immutable `skill://` reads, selected package/read receipts, edit receipts, argv-only command authorization/journaling and shared sandbox delegation, bounded approval-denial propagation, session-stat usage translation, policy-broker routing, setup races, timeout settlement, and committed/uncertain error classification | Temporary workspace and test-only runner at the SDK seam |
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
template parameters, version solving, executable extension containment, policy/UI packages, or
benchmark superiority.

The credential-free bundle-distribution suite proves deterministic packing, strict content parsing,
public-HTTPS-only digest-before-parse acquisition, DNS rebinding defenses, redirect refusal,
pre-abort and in-flight DNS cancellation, content-addressed activation, parent-synced store
creation, crash-boundary commit-uncertain reporting, fail-closed stale locks, collision handling,
bounded source traversal/read races, local inspection and removal, installed-catalog composition,
and network-free recovery. It does not claim publisher
identity, freshness, revocation, rollback protection, automatic updates, or safe executable package
payloads.

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
and detached-worker transport. They do not claim an artifact store, spill, download, retention,
garbage collection, or a physical disk quota.

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

## Live Pi test policy

Live tests are opt-in and excluded from `npm test`. Run them with both `FLOW_LIVE_PI_PROVIDER` and `FLOW_LIVE_PI_MODEL`; the live command fails rather than skips when either is absent. They incur no hidden fallback and fail clearly when provider configuration or credentials are invalid. Unit and integration tests never consume provider credentials. Provider-cost assertions use deterministic session-stat fakes; no local test claims correspondence with an external invoice.

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

Evidence-bound adaptation tests cover strict tuning-only projection, deterministic packet digests,
forbidden regression/holdout/verifier/run-handle fields, incomplete and contradictory ledgers,
internally contradictory outcomes/recovery metrics, duplicate pairs, maximum-size exports, bounded
diagnostics, impossible seed/repetition mappings and declared totals, strict prompt-candidate
schemas and bounds, exact prompt whitespace, stale
baseline/evidence/prompt identities, unrelated evidence, invalid targets, stable no-follow local
admission, candidate-root and nested-path symbolic-link races, path escapes, invalid UTF-8,
oversized and malformed evidence, exact comparison-baseline binding, generated-source provenance,
legacy direct-plan resume, and internally redigested durable candidate-identity refusal.
`test/integration/cli/prompt-candidate.test.ts` runs the credential-free vertical slice: complete
mixed-partition evaluation, tuning-only export and no-overwrite refusal, candidate validation,
candidate-plan admission, exact projected execution, offline inspect/export, candidate-drift resume
refusal, public-header tamper refusal, durable candidate identity, and unchanged baseline source.
These tests do not claim model-driven generation or activation; both remain future gates.

The production CLI integration runs the complete composition with a deterministic fake executor, so
unit and integration suites need no provider credentials or network. Live provider comparisons are
operator-run evidence and are not part of `npm test`.

Flow should be compared with the legacy plugin on held-out repository tasks using equivalent model,
thinking, budget, retry, network, fixture, verifier, seed, and order settings. A benchmark records
verified task success, false completion, cost, context volume, turns, tool failures, duration, human
intervention, policy violations, and recovery behavior when those metrics are available. Missing
records remain in the denominator and unavailable telemetry is never imputed as zero. Cost per
accepted result is emitted only from a complete profile schedule with cost available for every trial
and uses verifier-accepted results as its denominator.

Deterministic held-out checks are preferred. An LLM judge may supplement evidence but cannot override a failing command or missing artifact. Claims that the standalone harness beats the plugin require recorded benchmark results rather than architectural inference.

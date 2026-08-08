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
| Domain unit | Workflow/goal/budget/concurrency/config compilation, closed typed-result schema and strict JSON/canonicalization bounds, exact condition/guard/join/approval and bounded-loop/optimization expansion validation, child depth/tree/result/wait/budget bounds, persisted result/loop/child/optimization topology, numeric direction and invariant evaluation, delta rehashing, concurrent capacity and dependency replay, declaration-ordered outcomes and failure projection, durable result/decision/check/promotion/completion/omission/child replay, fresh-recovery policy bounds, monotonic attempt replay, proof-safe interruption eligibility, monotonic capacity merge, admission state-machine exploration, checked resource and UTF-8 artifact aggregation, exhaustion, policy and command/graph approval digests, pure criterion evaluation, and decision/effect/settlement/reconciliation/receipt/approval replay invariants | None |
| Application unit | Typed-result publication and condition/approval/verifier/loop/child/optimization composition, isolated candidate scheduling, accept/reject/stagnation/omission, tree-wide budget reservation/accounting including artifact ceilings and exact child roll-up, cancellation, sibling overlap, terminal and pre-ledger crash recovery, fail-closed missing-workspace recovery, promotion prepare/settlement/cleanup interruption, typed promotion reconciliation without reapply, unknown-state blocking, quiescent-wave admission and bounded artifact overshoot, overlap bounds, reverse completion with declaration order, selected-branch and loop-body concurrency, sequential iteration barriers, command and evidence-bound approval/control barriers, cancellation and failure quiescence, settlement-ceiling precedence, scheduler ordering, omission propagation, serialized write-ahead effect publication, ordered multi-attempt recovery observation/disposition, crash boundaries around result/loop/approval transitions and the resume marker, partial reconciliation progress, recovery compatibility, budget stop boundaries and timeout clamping, approval waits and expiry, completed-node skipping, failure propagation, and executor authority | Test-only in-memory ports |
| Infrastructure integration | Same-policy concurrent SRT session reference counting, cancellable cross-workspace session serialization, portable reflink-or-copy child snapshots with protected-path exclusion and manifest-bound recovery, bounded candidate capture, additions/modifications/deletions/modes/directories/symlinks, stale affected-path and removed-directory-closure refusal, write-ahead promotion and rollback blobs, live compensation, durable-temporary/applied-step/local-commit crash reconciliation, hostile-divergence classification, mutually waiting production command branches, atomic hash-anchored edits, chunk-bounded no-follow effect observation under target growth, portable non-regular and missing-ancestry classification, shared edit/reconciliation target coordination, real JSONL effect-journal reopening and fresh-attempt continuation, same-host edit-lock recovery, exact-byte versions, protected paths, process and approval-decision ownership, strict project/operator config, owner-only supervisor records, typed detached recovery refusal/success, atomic claims and command journals, admission replay/compaction, torn-tail repair, and real child processes | Temporary directories and local processes |
| CLI integration | Init, config inspection, validate, run, typed-result publication/inspection, attached/detached artifact-budget exhaustion and inspection, attached and detached child ledgers/workspaces, detached accepted/queued/rejected submission, events, active/queued cancel, supervisor status/shutdown, wait, approve/deny, exhaust, committed-boundary resume, proof-safe fresh resume, persist, and inspect through production composition | Temporary run ledgers, private local sockets, and local processes |
| Compiled-process integration | Direct-entry signal handling, process-group termination, edit crashes before rename, after rename, after directory sync, on settlement rejection, and after settlement persistence, cross-process run claiming, detached client exit, bounded concurrent admission, queued cancellation without execution, policy mismatch/rebinding, cancellation of a real process tree, supervisor restart/adoption, and real sandbox boundaries | Built CLI, temporary run ledgers, local process trees, native sandbox primitives, Unix sockets, and loopback networking |
| Pi adapter contract | Exact model/tool request translation, explicit zero turn/provider retries, versioned workspace and immutable `skill://` reads, selected package/read receipts, edit receipts, session-stat usage translation, policy-broker routing, setup races, timeout settlement, and committed/uncertain error classification | Temporary workspace and test-only runner at the SDK seam |
| Pi SDK integration | Real `ModelRuntime` and `createAgentSession` composition, `flow_read`/`flow_edit` tool turns, and streaming | Deterministic in-process provider; no network or credentials |
| Live Pi | Provider authentication, streaming, cancellation, and model compatibility | Opt-in network and provider cost |

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
drift immunity, and attached, detached, child, and recovery transport. They do not claim remote
installation, arbitrary evaluator-code isolation, provider correctness, or model-rubric safety.

The remaining examples use the real argv-only command executor through the production sandbox, accept declared goals from legacy command and first-class typed command-verifier evidence, publish strict canonical typed results, execute independently-ledgered isolated children, promote one bounded optimization candidate, exercise durable resource inspection and exact loop convergence, and require no model credentials. Focused child and optimization tests prove recursive contract bounds, deterministic linkage, typed composition, numeric direction and invariants, complete delta evidence, independent metadata/content/entry ceilings, idempotent capture reopening, stale-parent refusal, write-ahead promotion and compensation, tree-wide accounting, boundary cancellation without later evaluation or promotion, concurrency, crash recovery without reapply, protected-state exclusion, snapshot fidelity, replay mutation resistance, and cleanup. Focused result tests prove duplicate-key/I-JSON refusal, closed schema and complexity bounds, RFC 8785 canonicalization, resource neutrality, branch/approval/verifier/loop composition, recovery idempotence, and replay mutation resistance. Focused verifier tests use deterministic fake runners to prove exact durable input binding, zero-tool model invocation, strict verdict parsing, aggregate bounds, branch/approval/loop composition, cancellation precedence, budget narrowing, replay mutation resistance, and refusal to repeat an open attempt. Attached CLI and detached-worker integration preserve typed results, child histories, optimization evidence, promoted parent files, and verifier evidence through real JSONL stores. The bounded-loop example records one continue, one stop, unused-iteration omission, final verification, and cleanup; the optimization example records one accepted promotion, one equal rejection, stagnation, and cleanup. The ordinary concurrent CLI test makes two same-workspace SRT-contained commands wait for each other's workspace marker, so it fails under accidental same-session serialization; incompatible child-workspace SRT command phases are intentionally queued across session reset. Default integration tests also reopen interrupted agent attempts from real JSONL: applied edits remain blocked, while read-only or not-applied edit attempts with an explicit policy continue at the exact next attempt in both attached CLI and detached-worker paths. The tests prove repeated recovery cannot duplicate reconciliation, result publication, loop transitions, child import, candidate capture, candidate promotion, or interruption disposition. `npm run test:runtime` additionally spawns compiled children and exits writable workers at five deterministic edit boundaries—before rename, after rename, after a real directory sync, when settlement append rejects, and after settlement persistence—to verify ledger/file truth. It also delivers `SIGINT`, proves its POSIX command process group terminates, verifies the forced-exit guard for leaked provider handles, races separate processes for one run identifier, and attacks the real filesystem, environment, run-store, and loopback-network boundary. These tests do not simulate host reboot or power loss. The package supports Linux and macOS; Windows command nodes fail before spawn because descendant containment is not yet implemented.

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

Flow should be compared with the legacy plugin on held-out repository tasks using equivalent model settings. A benchmark records verified task success, false completion, cost, context volume, tool failures, duration, human intervention, policy violations, and crash/replay behavior.

Deterministic held-out checks are preferred. An LLM judge may supplement evidence but cannot override a failing command or missing artifact. Claims that the standalone harness beats the plugin require recorded benchmark results rather than architectural inference.

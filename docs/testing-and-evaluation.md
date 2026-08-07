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
| Domain unit | Workflow/goal/budget/config compilation, fresh-recovery policy bounds, monotonic attempt replay, proof-safe interruption eligibility, monotonic capacity merge, admission state-machine exploration, checked resource aggregation, exhaustion, policy and approval operation digests, pure criterion evaluation, and decision/effect/settlement/reconciliation/receipt/approval replay invariants | None |
| Application unit | Scheduler ordering, serialized write-ahead effect publication, ordered and idempotent recovery observation/disposition, crash boundaries around the resume marker, partial reconciliation progress, recovery compatibility, budget stop boundaries and timeout clamping, approval waits and expiry, completed-node skipping, failure propagation, and executor authority | Test-only in-memory ports |
| Infrastructure integration | Atomic hash-anchored edits, chunk-bounded no-follow effect observation under target growth, portable non-regular and missing-ancestry classification, shared edit/reconciliation target coordination, real JSONL effect-journal reopening and fresh-attempt continuation, same-host edit-lock recovery, exact-byte versions, protected paths, process and approval-decision ownership, strict project/operator config, owner-only supervisor records, typed detached recovery refusal/success, atomic claims and command journals, admission replay/compaction, torn-tail repair, and real child processes | Temporary directories and local processes |
| CLI integration | Init, config inspection, validate, run, detached accepted/queued/rejected submission, events, active/queued cancel, supervisor status/shutdown, wait, approve/deny, exhaust, committed-boundary resume, proof-safe fresh resume, persist, and inspect through production composition | Temporary run ledgers, private local sockets, and local processes |
| Compiled-process integration | Direct-entry signal handling, process-group termination, edit crashes before rename, after rename, after directory sync, on settlement rejection, and after settlement persistence, cross-process run claiming, detached client exit, bounded concurrent admission, queued cancellation without execution, policy mismatch/rebinding, cancellation of a real process tree, supervisor restart/adoption, and real sandbox boundaries | Built CLI, temporary run ledgers, local process trees, native sandbox primitives, Unix sockets, and loopback networking |
| Pi adapter contract | Exact model/tool request translation, explicit zero turn/provider retries, versioned reads, edit receipts, session-stat usage translation, policy-broker routing, setup races, timeout settlement, and committed/uncertain error classification | Temporary workspace and test-only runner at the SDK seam |
| Pi SDK integration | Real `ModelRuntime` and `createAgentSession` composition, `flow_read`/`flow_edit` tool turns, and streaming | Deterministic in-process provider; no network or credentials |
| Live Pi | Provider authentication, streaming, cancellation, and model compatibility | Opt-in network and provider cost |

Test doubles are permitted only in tests at explicit ports. Production modules contain no mock executor, fake provider, fallback success, or sample result.

## Runtime smoke test

After `npm run build`:

```sh
node dist/cli/main.js --help
node dist/cli/main.js init .
node dist/cli/main.js config show
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id smoke
node dist/cli/main.js inspect smoke
node dist/cli/main.js run examples/budgeted-foundation.workflow.yaml --run-id budget-smoke
node dist/cli/main.js inspect budget-smoke
node dist/cli/main.js run examples/approval-gated-command.workflow.yaml --run-id approval-smoke
node dist/cli/main.js approve approval-smoke approval-2 --actor local:smoke
node dist/cli/main.js resume examples/approval-gated-command.workflow.yaml --run-id approval-smoke
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --detach --run-id detached-smoke
node dist/cli/main.js events detached-smoke --after 0 --follow
node dist/cli/main.js supervisor status
node dist/cli/main.js supervisor shutdown
```

The examples use the real argv-only command executor through the production sandbox, accept a declared goal from terminal typecheck evidence, exercise durable resource inspection, and require no model credentials. Default integration tests also reopen interrupted agent attempts from real JSONL: applied edits remain blocked, while read-only or not-applied edit attempts with an explicit policy continue at the exact next attempt in both attached CLI and detached-worker paths. The tests prove repeated recovery cannot duplicate reconciliation or interruption disposition. `npm run test:runtime` additionally spawns compiled children and exits writable workers at five deterministic edit boundaries—before rename, after rename, after a real directory sync, when settlement append rejects, and after settlement persistence—to verify ledger/file truth. It also delivers `SIGINT`, proves its POSIX command process group terminates, verifies the forced-exit guard for leaked provider handles, races separate processes for one run identifier, and attacks the real filesystem, environment, run-store, and loopback-network boundary. These tests do not simulate host reboot or power loss. The package supports Linux and macOS; Windows command nodes fail before spawn because descendant containment is not yet implemented.

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

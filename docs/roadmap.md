# Delivery roadmap

The roadmap is organized around externally verifiable capability gates rather than dates.

Gates 0–2 are implemented. Gate 3 has a model-tool policy broker, a full-SHA hash-anchored single-file edit, durable effect receipts, fail-closed native command containment, and exact expiring approval for deterministic command nodes. Gate 4 has committed-boundary recovery, exclusive same-host ownership, write-ahead durable edit evidence, typed reconciliation of open hash-anchored edits, opt-in proof-safe fresh recovery of interrupted agent attempts, client-detachable approval waits, durable limits for node starts, model tokens, reported model cost, and active execution time, project/operator capacity configuration, plus a bounded local supervisor with authenticated detached workers, durable FIFO admission, queued and active cancellation, bounded event replay, policy-safe restart, and worker adoption. Gate 5 has replay-safe exact-output conditions, guarded branches, first-class omission, explicit joins, deterministic bounded concurrency for static DAG forks, finite replay-safe bounded and accept-best optimization loops, durable evidence-bound graph approval nodes, replay-verified typed results, typed verifier nodes with command and zero-tool model drivers, independently-ledgered child workflows, and write-ahead candidate promotion in isolated copy-on-write-or-copy workspaces. Gate 6 now has two vertical slices: strict local portable Agent Skills and strict local versioned command/model verifier packages, both with explicit selection, immutable attached/detached/child/recovery snapshots, and digest-bound use evidence. Dynamic agent-tool approval, remote installation, executable extensions, other capability package types, arbitrary evaluator runtimes, execute/network model tools, broader configurable policy, opaque session continuation, general failure/fallback retries, artifact budgets, and stronger VM or managed backends remain target capabilities.

## Gate 0: Repository foundation

- Architecture, capability ownership, failure modes, and non-goals are documented.
- The toolchain provides formatting, linting, type checking, tests, builds, and reproducible installation.
- Contribution and security guidance exist before accepting external packages.

## Gate 1: Executable graph vertical slice

- A workflow is parsed and rejected with structured diagnostics when invalid.
- Dependencies determine node execution order without model discretion.
- Node and run transitions are appended to a durable ledger before advancement.
- A failed node prevents dependent nodes from executing.
- A real Pi adapter implements the production agent-execution boundary.
- The CLI builds, exposes help, validates a workflow, and exercises a sample run path.

## Gate 2: Evidence-based completion

- Goals and criteria have versioned contracts.
- Evidence is linked to a run, node, attempt, and criterion.
- Deterministic verification controls acceptance.
- Evaluators are isolated from implementation rationale and workspace mutation.
- Missing or inconclusive evidence cannot become success.

## Gate 3: Policy and safe effects

- All model-requested tools pass through a Flow-owned broker.
- Policy classifies reads, writes, execution, network, credentials, and destructive operations.
- Approval binds an exact operation and expires predictably. *(Implemented for deterministic command nodes.)*
- Timeouts terminate process trees and record partial output.
- Side-effect uncertainty blocks automatic retry.
- Full-SHA hash-anchored edit of an existing UTF-8 file records before/after effect receipts, coordinates cooperating same-host Flow processes, and fails closed on stale content. *(Implemented.)*
- A Flow-owned sandbox port isolates command execution from the selected backend. *(Implemented for SRT.)*
- The initial fixed profile denies network and ambient credentials, permits workspace work, protects durable state, and records provenance. *(Implemented.)*
- Missing or degraded containment fails before command spawn. *(Implemented.)*
- VM, container, and managed sandbox adapters can satisfy higher-isolation deployment profiles.

## Gate 4: Recovery and long-running work

- Runs resume from authoritative events after process interruption. *(Implemented at committed node boundaries.)*
- Only one same-host process owns append and execution for a run; exited ownership is recoverable. *(Implemented.)*
- Flow-owned workspace edits persist typed prepare/settle evidence across interruption. *(Implemented.)*
- Supported open edits are reconciled before any future retry decision. *(Implemented for exact hash/mode observation under the shared target lock.)*
- Interrupted agent attempts may start a fresh numbered attempt only under a persisted opt-in, bounded attempt cap, and replay proof that every effect was not applied. *(Implemented for read-only and `flow.effects/v1` edit attempts; applied, unknown, open, legacy writable, and unaccountable resource states remain blocked.)*
- A supervisor owns detached workers, health, cancellation, and event replay. *(Implemented with strict project/operator capacity configuration, durable bounded FIFO admission, explicit accepted/queued/rejected outcomes, queued cancellation without execution, authenticated restart adoption, policy binding, and bounded cursor replay.)*
- Budgets cover attempts/node starts, model tokens, reported cost, and active execution time. *(Implemented for bounded per-node fresh attempts, run-wide node starts, model tokens, reported cost, and active execution time; supervisor-wide worker capacity and per-run graph-node concurrency are also bounded, while artifact limits remain.)*
- Human wait states survive client detachment. *(Implemented for command and evidence-bound graph approval waits.)*

## Gate 5: Graph and loop completeness

- Exact-output conditions, guarded branches, omission propagation, and explicit joins are executable and replay-safe. *(Implemented; arbitrary expressions are not.)*
- Concurrent static DAG fork/join is executable with a strict per-run node limit and deterministic quiescent waves. *(Implemented; dynamic fan-out is not.)*
- Bounded loops, general approval nodes, and general verifier nodes are executable. *(Implemented through finite acyclic loop expansion, pure evidence-bound approval nodes, and typed verifier nodes with sandboxed command plus evidence-isolated zero-tool model drivers. Strict local versioned verifier packages are implemented in Gate 6.)*
- Typed results publish bounded canonical JSON from exact durable evidence and compose with conditions, approvals, model verifiers, and loop checks. *(Implemented with a closed schema subset, strict duplicate-key/I-JSON parsing, RFC 8785 canonicalization, source/schema/value hashes, attached and detached execution, inspection, and replay verification.)*
- Optimization loops declare a metric, baseline, direction, invariants, candidate bound, stagnation rule, and rollback strategy. *(Implemented through finite acyclic candidate/check expansion, strict typed numeric evaluation, exact scalar invariants, persisted path deltas, stale affected-path refusal, write-ahead promotion with rollback blobs, typed reconciliation, accept-best state, attached/detached execution, and replay-verified inspection.)*
- Child runs use isolated workspaces and typed results. *(Implemented with embedded bounded workflows, deterministic child identities, independent JSONL histories, exact parent snapshots through a portable reflink-or-copy backend, tree-wide budget admission/accounting, cancellation and recovery, typed result composition, and attached/detached execution. Ordinary child changes are discarded; only compiler-registered optimization candidates may enter the bounded promotion protocol. Native snapshot backends remain.)*
- Packages cannot bypass graph dependencies or joins.

## Gate 6: Capability ecosystem

- Agent Skills packages are discovered with progressive disclosure. *(Implemented for strict local project packages with explicit per-node selection, immutable attached/detached/child/recovery snapshots, and bounded `skill://` reads.)*
- Package provenance, digest, license, permissions, compatibility, trust state, and observed use are recorded. *(Implemented with permission requests that cannot widen Flow authority.)*
- Evaluator contributions use versioned manifests. *(Implemented for strict local command/model verifier packages with exact version selection, inert manifest-only directories, immutable attached/detached/child/recovery snapshots, and digest-bound verdict evidence.)*
- Tool, workflow, policy, and UI contributions use versioned manifests.
- OMP-inspired high-value tools are benchmarked before adoption.

## Gate 7: Adaptive harness

- Repeated evidence can produce candidate changes to skills, memory, prompts, or routing profiles.
- Candidates are evaluated against held-out and regression workflows.
- Activation is versioned, reviewable, scoped, and rollbackable.
- Base safety, workflow semantics, and evaluator definitions remain immutable during a run.

## Product benchmark gate

The standalone harness is compared against the legacy plugin on held-out repository tasks using equivalent model configurations. Record:

- Verified success rate
- Cost per accepted task
- Total context processed
- Model turns and tool failures
- Wall-clock duration
- Human interventions and policy violations
- False completion claims
- Crash and resume success
- Performance across multiple providers

Hidden deterministic tests are preferred over LLM judges. A release claim that Flow beats the plugin requires measured improvement rather than feature count.

# Delivery roadmap

The roadmap is organized around externally verifiable capability gates rather than dates.

Gates 0–2 are implemented. Gate 3 includes policy, approvals, hash-anchored edits, durable effect
receipts, and sandboxed argument-vector command execution.

Gate 4 includes recovery, same-host ownership, effect reconciliation, durable budgets, detached
workers, bounded queueing, cancellation, replay, and worker adoption.

Gate 5 includes conditions, joins, bounded concurrency, loops, graph approvals, typed results,
verifiers, child workflows, and isolated optimization promotion.

Gate 6 includes Agent Skills, verifier packages, command tool packages, workflow packages, inert
bundles, content-addressed installation, audit, removal, and offline recovery.

Deterministic inert bundles and content-addressed installation are implemented.

Flow supports paired harness evaluation with fixed controls, fresh fixtures, private verification,
digest-chained evidence, offline reports, and constrained comparison.

Gate 7 includes tuning-only prompt candidates, zero-tool model generation, exact prompt overlays,
paired evaluation, reviewed activation, durable run snapshots, and rollback.

Remaining targets include executable extensions, signed registries, automatic updates, policy and
UI packages, a Prime Agent adapter, external artifact storage, and stronger isolation.

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
- Approval binds an exact operation and expires predictably. *(Implemented for deterministic command nodes and each live agent `exec` request.)*
- Timeouts terminate Linux PID-namespace process trees or POSIX process groups and record partial output.
- Side-effect uncertainty blocks automatic retry.
- Full-SHA hash-anchored edit of an existing UTF-8 file records before/after effect receipts, coordinates cooperating same-host Flow processes, and fails closed on stale content. *(Implemented.)*
- A Flow-owned sandbox port isolates command execution from the selected backend. *(Implemented for SRT.)*
- The initial fixed profile denies network and ambient credentials, permits workspace work, protects durable state, and records provenance. *(Implemented.)*
- Missing or degraded containment fails before command spawn. *(Implemented; agent `exec` currently requires verified Linux PID-namespace containment.)*
- Explicit agent `exec` uses the same sandboxed command executor, exact process authorization, optional per-call human approval, write-ahead prepare/settle events, bounded output evidence, and replay-derived artifact accounting. *(Implemented.)*
- VM, container, and managed sandbox adapters can satisfy higher-isolation deployment profiles.

## Gate 4: Recovery and long-running work

- Runs resume from authoritative events after process interruption. *(Implemented at committed node boundaries.)*
- Only one same-host process owns append and execution for a run; exited ownership is recoverable. *(Implemented.)*
- Flow-owned workspace edits persist typed prepare/settle evidence across interruption. *(Implemented.)*
- Supported open edits are reconciled before any future retry decision. *(Implemented for exact hash/mode observation under the shared target lock.)*
- Interrupted agent attempts may start a fresh numbered attempt only under a persisted opt-in, bounded attempt cap, and replay proof that every effect was not applied. *(Implemented for read-only and `flow.effects/v1` edit attempts; applied, unknown, open, legacy writable, and unaccountable resource states remain blocked.)*
- A supervisor owns detached workers, health, cancellation, and event replay. *(Implemented with strict project/operator capacity configuration, durable bounded FIFO admission, explicit accepted/queued/rejected outcomes, queued cancellation without execution, authenticated restart adoption, policy binding, and bounded cursor replay.)*
- Budgets cover attempts/node starts, model tokens, reported cost, active execution time, and retained executor-output artifacts. *(Implemented with replay-derived UTF-8 artifact accounting, terminal equality/overshoot settlement, attached/detached inspection, concurrency-wave quiescence, and child ceiling reservation plus exact tree roll-up. External artifact storage, spill, download, retention, and garbage collection remain separate.)*
- Human wait states survive client detachment. *(Implemented for command and evidence-bound graph waits plus live attached/detached agent command calls; opaque continuation after the owner process dies remains separate.)*

## Gate 5: Graph and loop completeness

- Exact-output conditions, guarded branches, omission propagation, and explicit joins are executable and replay-safe. *(Implemented; arbitrary expressions are not.)*
- Concurrent static DAG fork/join is executable with a strict per-run node limit and deterministic quiescent waves. *(Implemented; dynamic fan-out is not.)*
- Bounded loops, general approval nodes, and general verifier nodes are executable. *(Implemented through finite acyclic loop expansion, pure evidence-bound approval nodes, and typed verifier nodes with sandboxed command plus evidence-isolated zero-tool model drivers. Strict local versioned verifier packages are implemented in Gate 6.)*
- Typed results publish bounded canonical JSON from exact durable evidence and compose with conditions, approvals, model verifiers, and loop checks. *(Implemented with a closed schema subset, strict duplicate-key/I-JSON parsing, RFC 8785 canonicalization, source/schema/value hashes, attached and detached execution, inspection, and replay verification.)*
- Optimization loops declare a metric, baseline, direction, invariants, candidate bound, stagnation rule, and rollback strategy. *(Implemented through finite acyclic candidate/check expansion, strict typed numeric evaluation, exact scalar invariants, persisted path deltas, stale affected-path refusal, write-ahead promotion with rollback blobs, typed reconciliation, accept-best state, attached/detached execution, and replay-verified inspection.)*
- Child runs use isolated workspaces and typed results. *(Implemented with embedded bounded workflows, deterministic child identities, independent JSONL histories, exact parent snapshots through a portable reflink-or-copy backend, tree-wide budget admission/accounting, cancellation and recovery, typed result composition, and attached/detached execution. Ordinary child changes are discarded; only compiler-registered optimization candidates may enter the bounded promotion protocol. Native snapshot backends remain.)*
- Packages cannot bypass graph dependencies or joins.

## Gate 6: Capability ecosystem

- Agent Skills packages are discovered with progressive disclosure. *(Implemented for strict local and digest-pinned installed project packages with explicit per-node selection, immutable attached/detached/child/recovery snapshots, and bounded `skill://` reads.)*
- Package provenance, digest, license, permissions, compatibility, trust state, and observed use are recorded. *(Implemented with permission requests that cannot widen Flow authority.)*
- Evaluator contributions use versioned manifests. *(Implemented for strict local and digest-pinned installed command/model verifier packages with exact version selection, immutable snapshots, and digest-bound verdict evidence.)*
- Tool contributions use versioned manifests. *(Implemented for strict local and digest-pinned installed declarative command tools with exact per-agent selection, closed Flow-owned data-position command profiles, typed scalar-to-literal-argv rendering, immutable snapshots, independently reconciled raw-exec authority, and reuse of the existing policy/approval/sandbox/journal boundary. Executable package code remains deferred.)*
- Capability distribution is deterministic, reviewable, and provider-neutral. *(Implemented with strict `.flowpkg` packing, explicit canonical public HTTPS plus caller-supplied SHA-256 installation, content-addressed blobs, deterministic project lock state, fail-closed collisions, local inspection/verification/removal, and network-free execution/recovery. Publisher signatures, registry discovery, freshness, revocation, rollback protection, and automatic updates remain deferred.)*
- Workflow contributions use versioned manifests. *(Implemented for inert exact-version workflow source with packaged root/child selection, ordinary recursive compilation, immutable transitive snapshots, deterministic bundle distribution, detached execution, and fail-closed recovery. Parameterized templates and executable modules remain deferred.)*
- Policy and UI contributions use versioned manifests.
- OMP-inspired high-value tools are benchmarked before adoption.

## Gate 7: Adaptive harness

- Flow can produce evidence-bound prompt candidates from canonical tuning-only evaluation evidence. *(Implemented for exact prompt-only manifests and zero-tool model generation.)*
- Skill, memory, sub-agent, and routing candidates remain planned.
- Prompt candidates use the paired held-out and regression evaluation gate. *(Implemented.)*
- Activation is versioned, reviewable, scoped, and rollbackable. *(Implemented with operator preview, exact apply, paired candidate and baseline artifacts, and baseline or version rollback.)*
- Base safety, workflow semantics, and evaluator definitions remain immutable during a candidate run. *(Implemented for prompt projection: graph, models, tools, skills, packages, policy, approvals, budgets, verifiers, retry behavior, and runtime semantics cannot be changed by the candidate.)*

## Product benchmark gate

- Reproducible harness evaluation is implemented for two Flow profiles. It includes paired
  scheduling, immutable trial evidence, offline inspection and export, explicit missingness, and
  constrained comparison.
- A native Pi adapter also supports paired Flow-versus-Pi evaluation. It uses a pinned driver, SRT,
  private host inference, durable adapter starts, installed-byte identity, Linux PID-namespace
  containment, and parent-owned process evidence.
- A native OMP adapter supports paired Pi-versus-OMP evaluation. It uses pinned OMP packages, an
  attested official Bun executable, SRT, private host inference, installed-byte identity, and
  parent-owned process evidence.
- A Prime Agent adapter supports paired Flow-versus-Prime evaluation on Linux x64. It uses a fixed
  OCI image, persistent IPython, private host inference, durable leases, and confirmed removal.
- A public claim that Flow beats the legacy plugin remains pending measured held-out evidence.

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

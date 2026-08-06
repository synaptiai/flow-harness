# Delivery roadmap

The roadmap is organized around externally verifiable capability gates rather than dates.

Gates 0–2 are implemented. Gate 3 now has a model-tool policy-broker slice and fail-closed native command containment; approvals, broader model tools, configurable policy, and stronger VM or managed backends remain target capabilities.

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
- Approval binds an exact operation and expires predictably.
- Timeouts terminate process trees and record partial output.
- Side-effect uncertainty blocks automatic retry.
- A Flow-owned sandbox port isolates command execution from the selected backend. *(Implemented for SRT.)*
- The initial fixed profile denies network and ambient credentials, permits workspace work, protects durable state, and records provenance. *(Implemented.)*
- Missing or degraded containment fails before command spawn. *(Implemented.)*
- VM, container, and managed sandbox adapters can satisfy higher-isolation deployment profiles.

## Gate 4: Recovery and long-running work

- Runs resume from authoritative events after process interruption.
- Open operations are reconciled before retry.
- A supervisor owns detached workers, health, cancellation, and event replay.
- Budgets cover attempts, tokens, cost, duration, concurrency, and artifacts.
- Human wait states survive client detachment.

## Gate 5: Graph and loop completeness

- Conditions, fork/join, bounded loops, approval nodes, and verifier nodes are executable.
- Optimization loops declare a metric, baseline, direction, invariants, budget, stagnation rule, and rollback strategy.
- Child runs use isolated workspaces and typed results.
- Packages cannot bypass graph dependencies or joins.

## Gate 6: Capability ecosystem

- Agent Skills packages are discovered with progressive disclosure.
- Package provenance, digest, license, permissions, and compatibility are recorded.
- Tool, evaluator, workflow, policy, and UI contributions use versioned manifests.
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

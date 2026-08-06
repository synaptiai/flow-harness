# Decision Journal: Issue #4 — Evidence-based completion

**Issue**: #4 | **Branch**: `codex/issue-4-evidence-completion` | **Started**: 2026-08-06

---

## Specification

_Captured on 2026-08-06. Source: issue #4, the delivery roadmap, and the existing architecture contract._

### Non-goals

- This gate does not add model-authored or probabilistic acceptance decisions.
- This gate does not add policy brokering, approvals, sandboxing, retries, resume, parallel scheduling, or loops.
- This gate does not claim that command verifiers are operating-system sandboxes; the current trusted-workspace execution contract remains unchanged.
- This gate does not require every operational workflow to declare a goal. Workflows that declare no goal retain graph-completion semantics and report no goal decision.
- This gate does not introduce a separate database, daemon, or evaluator service.

### Failure modes

- **Timeouts** — A verifier command that times out remains a failed node attempt and produces an `inconclusive` criterion decision when its bounded command evidence cannot establish a normal non-zero verifier result. The run cannot succeed.
- **Partial failures** — Accepted criteria remain traceable, the failed verifier becomes `rejected` or `inconclusive`, unexecuted criteria become `missing` when the run terminates, and the overall goal is not accepted.
- **Invalid input** — Invalid goal versions, empty or duplicate criterion identifiers, unknown verifier nodes, and non-command or non-terminal verifier nodes are rejected during compilation with structured paths and diagnostic codes.
- **Missing context** — A terminal run with no completed verifier attempt marks each still-pending required criterion `missing`; missing evidence never becomes acceptance.
- **Dependency outage** — Provider or process failures retain their existing node failure semantics. Criterion evaluation consumes only durable node outcomes and does not call an external dependency.
- **Resource exhaustion** — Goal and criterion counts and text are bounded, and the complete serialized goal is capped at 256 KiB so a valid contract fits within the 1 MiB event ceiling; persisted node evidence retains the existing output bounds.

### Interface contracts

- A workflow may declare one embedded, independently versioned `Goal` contract with a stable goal id, an outcome, and one or more uniquely identified criteria.
- Each criterion names exactly one verifier node. The verifier must exist, be a command node, and be terminal in the compiled graph.
- The `run_started` event durably captures the compiled goal contract when present so inspection and replay do not need the original workflow file.
- Run state exposes `goal: null` for graph-only workflows or an immutable goal state containing an overall status and criterion states.
- Criterion states are `pending`, `accepted`, `rejected`, `inconclusive`, or `missing`. A decision records the run id, verifier node id, attempt, timestamp, and whether command evidence is available.
- A successful verifier node accepts its linked criteria. A normal non-zero verifier result rejects them. Timeout, signal, missing command evidence, or an unexpected evidence kind is inconclusive.
- `run_succeeded` is valid for a goal-bearing run only when every criterion is accepted. Any other terminal run marks pending criteria missing and the goal not accepted.

## Flow map

### User flows

1. **Validate** — user supplies a workflow → Flow validates graph and goal contracts together → structured diagnostics identify invalid criterion declarations before side effects.
2. **Run** — user starts a valid workflow → Flow commits the goal contract with `run_started` → deterministic command outcomes update criterion state → Flow commits success only when every required criterion is accepted.
3. **Inspect** — user opens a run id → Flow replays only the durable ledger → output includes the same goal and criterion decisions returned by live execution.

### Operator flows

1. **Audit** — operator reads a criterion decision → follows its decision reference to the exact run, node, attempt, and integrity-checked node evidence.
2. **Diagnose incomplete work** — operator distinguishes rejected verification from infrastructure-inconclusive verification and from a verifier that never ran.

### System flows

1. **Replay** — parse each event → apply the same pure criterion transitions used during live execution → reject impossible success or invalid evidence.

## Architecture decision

### Options considered

| Option | Advantages | Costs and risks |
| --- | --- | --- |
| Append separate criterion-decision events | Decisions are explicit ledger rows | Duplicates facts already present in verifier events and creates an ordering/integrity problem between node and criterion events |
| Derive criterion decisions from the captured goal contract and authoritative node events | One source of truth, deterministic replay, no new side effects | Requires the reducer to maintain a richer immutable state |
| Run a separate evaluator process after the graph | Strong process boundary and future extensibility | Introduces another executable effect before policy/sandboxing and can diverge from durable replay |

### Decision

Derive criterion decisions inside a pure goal evaluator from the goal contract stored in `run_started` and authoritative node completion events. The run reducer remains the sole lifecycle authority. The evaluator receives no prompt, model output, filesystem handle, or executor and therefore cannot mutate the workspace or rely on implementation rationale.

### Coupling analysis

- Goal contracts and criterion transitions form a dependency-free domain module.
- Workflow compilation depends on the goal contract schema and produces an immutable compiled goal.
- Run events depend on goal domain types and transitions; the goal domain does not import run events, avoiding a cycle.
- Application execution only persists the compiled goal at run start. It does not make criterion decisions itself.
- CLI output requires no special formatter because it already serializes the replayed run state.

### Consequences

- Old ledgers without a goal remain replayable and yield `goal: null`.
- Goal-bearing workflows gain fail-closed success semantics without an external evaluator service.
- Command execution remains trusted-workspace behavior; only the criterion evaluator itself is mutation-free.
- Explicit decision events can be introduced in a future event version only if external evaluator attestations require them.

## Criterion verification map

| Acceptance criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Invalid or ambiguous declarations are rejected | Error/contract | `npm test -- --run test/unit/workflow/compiler.test.ts` | Invalid versions, duplicates, unknown nodes, and invalid verifier kinds produce structured diagnostics | Does not validate later policy or loop syntax |
| Stable criterion identity and verification contract | Contract | `npm test -- --run test/unit/workflow/compiler.test.ts` | Compiled immutable goal retains ids and verifier bindings | Does not provide cross-workflow global ids |
| Decisions trace to bounded evidence | Behavioral | `npm test -- --run test/unit/run/reducer.test.ts` | Criterion decision references exact run/node/attempt and node evidence passes integrity validation | Does not create external artifact storage |
| Deterministic verification controls acceptance | Behavioral | `npm test -- --run test/unit/application/run-workflow.test.ts` | Agent success cannot satisfy a criterion; command verifier success can | Does not add probabilistic judges |
| Missing, rejected, or inconclusive evidence blocks success | Error handling | `npm test -- --run test/unit/run/reducer.test.ts` | Impossible success is rejected and terminal failure classifies every criterion | Does not retry failed verification |
| Evaluation cannot mutate or consume rationale | Contract | `npm test -- --run test/unit/goal/evaluator.test.ts` | Pure evaluator accepts only contract and outcome metadata and returns frozen state | Does not sandbox the verifier command |
| Inspection reports every criterion | Behavioral | `npm test -- --run test/integration/cli/main.test.ts` | Run and inspect JSON expose identical criterion states and decision references | Does not add a TUI |
| Replay reproduces completion | Data processing | `npm test -- --run test/unit/run/reducer.test.ts` | Repeated reduction of the same ledger is deeply equal | Does not implement interrupted-run resume |

## Stranger test

A new implementer can determine from this journal that the change adds an optional versioned goal contract, binds every criterion to a terminal command verifier, persists that contract in the first event, derives immutable criterion decisions from node events, and prevents goal-bearing success unless all criteria are accepted. The implementer can also identify the explicit trusted-workspace limitation and the exact test command for every acceptance criterion.

## Implementation

- Added optional embedded versioned goals with bounded outcomes, criteria, verifier bindings, and a 256 KiB aggregate serialized limit.
- Added compiler diagnostics for duplicate criteria and unknown, non-command, or non-terminal verifiers.
- Added a pure immutable goal evaluator with `pending`, `accepted`, `rejected`, `inconclusive`, and `missing` criterion states.
- Persisted the compiled goal in `run_started` and derived criterion decisions from authoritative node events during both live append and replay.
- Prevented `run_succeeded` when any declared criterion is not accepted.
- Exposed criterion counts in validation and complete goal state in existing run/inspect JSON.
- Updated the production example and current-vs-target documentation.
- Replaced a timing-based cancellation test delay with a child-start marker after local CI exposed the race.

## Review

- **Resolved P2 — aggregate event budget**: individually valid maximum-size criteria could combine into a goal too large for the run-start ledger event. Added a serialized-goal ceiling and regression coverage.
- **Resolved P2 — identifier map collision**: the valid criterion id `constructor` collided with `Object.prototype`. Criterion maps now use a null-prototype builder and own-property checks.
- **Resolved P3 — cancellation test race**: fixed-delay cancellation could occur before process start. The test now waits for an observable start marker.
- Final two-stage review found no remaining actionable security, correctness, performance, maintainability, test, error-handling, or claim-verification findings.

## Verification

- `npm run check` — passed: formatting, lint, strict typecheck, 117 default tests, build, and 4 compiled-process tests.
- `npm run test:coverage` — passed: 86.63% statements, 78.70% branches, 87.19% functions, 86.94% lines.
- Production example — validation reported 2 nodes and 1 criterion; live run and ledger replay both reported the goal and criterion as accepted with the same decision reference.
- `npm run pack:check` — passed with the compiled goal domain included in the 70-file package.
- Isolated tarball install and installed `flow --help` — passed.
- `npm audit --omit=dev --audit-level=low` — zero vulnerabilities.
- `actionlint .github/workflows/ci.yml` and `git diff --check` — passed.

### Evidence completeness

- **What was not tested** — live paid model providers, Windows command execution (intentionally unsupported), very large repositories, concurrent scheduling, resume, and later policy/sandbox/loop capabilities.
- **Known limitations** — local command output is self-reported by this development environment; verifier commands still have trusted-workspace authority and are not sandboxed.
- **Negative and adversarial cases covered** — invalid goal versions, duplicate criteria, unknown verifiers, agent verifiers, non-terminal verifiers, oversized aggregate goals, prototype-name ids, forged agent-success evidence, non-zero verification, timeout, missing evidence after cancellation, replay equivalence, and process cancellation timing.

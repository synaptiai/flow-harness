# Decision Journal: Issue #40 — Execute durable typed verifier nodes

**Issue**: #40 | **Branch**: `codex/issue-40-durable-verifier-nodes` | **Started**:
2026-08-07

---

## Init

### Context and invocation reason

Gate 5 still lacks a first-class verifier node. Flow's current goal evaluator binds criteria to
terminal commands: a normal exit zero accepts, a normal non-zero rejects, and infrastructure
uncertainty is inconclusive. That is a strong deterministic baseline, but the workflow cannot state
that a node is an evaluator, cannot use another provider as an evidence-isolated reviewer, and has
no driver-neutral verifier evidence contract for future package implementations.

Pi provides an embeddable provider-neutral model session. It does not define Flow's graph,
evidence, verdict, or replay authority. OMP's advisor validates a separately scoped reviewer but is
transcript-oriented and can steer a live session. Prime's verifier ecosystem validates explicit
evaluation boundaries, while Prime Agent correctly warns that a passed gate proves only what the
gate checks. Flow needs its own stricter outer-loop contract: declared durable evidence enters one
bounded verifier driver, a typed verdict leaves it, and only the scheduler can advance the graph.

### Current invariants

- The compiled graph is finite and acyclic; current failure semantics stop the run and expose no
  fallback edge.
- Command nodes execute through the Flow-owned sandbox and preserve bounded argv, output hashes,
  truncation, duration, containment provenance, and conservative side-effect classification.
- Agent nodes execute through Pi with a Flow-owned locked resource loader, declared tool allowlist,
  provider-neutral usage evidence, and no authority over graph transitions.
- Goals are immutable at run start. Their mutation-free evaluator consumes only durable node
  outcomes and never receives a transcript, workspace handle, executor, or tool.
- Conditions, approval nodes, and loop checks consume only typed direct-dependency fields and bind
  source node, attempt, field, hash, and truncation state.
- Executor starts, outcomes, resource usage, cancellation, and recovery are durable and replayed
  without consulting a provider.
- Interrupted executable attempts are not silently retried; only explicitly eligible agent nodes
  can start a fresh attempt after proof-safe recovery.

## Research findings

- Pi's SDK and locked `ResourceLoader` let Flow construct an in-memory session with an exact system
  prompt, zero built-in tools, zero extensions, zero skills, zero context files, bounded output,
  disabled Pi/provider retries, and Flow-selected model configuration. This is the correct runtime
  primitive for a model verifier, not a persisted domain type.
- OMP's advisor uses a distinct session and usually a read-only tool surface, and it cannot directly
  approve actions or mutate primary session state. Flow should keep the separate reviewer shape but
  make the input and verdict durable outer-graph facts rather than live transcript steering.
- Prime Agent's autonomous gates explicitly do not imply overall success. Flow must preserve that
  rule by naming the verdict, source observations, driver, and assurance limits in evidence.
- Prime Verifiers is a useful evaluator ecosystem reference, but importing its Python environment
  and reward contracts would couple the first Flow node to an RL-specific runtime. A Flow-owned port
  is the smaller stable seam.
- Evidence delimiters and a dedicated system prompt reduce accidental instruction following but do
  not make model evaluation prompt-injection-proof. Model verdicts remain explicitly probabilistic
  and lower assurance than deterministic hidden checks.
- Existing per-field bounds do not cap aggregate model input. Sixteen individually valid 64 KiB
  values could exceed one MiB before prompt overhead, so the rendered input needs its own hard
  256 KiB UTF-8 ceiling.
- A failed command may already have mutated the workspace. The verifier wrapper must preserve the
  command executor's `sideEffectStatus` rather than relabeling rejection as side-effect-free.

## Specification

### Non-goals

- This slice does not add failure edges, remediation branches, fallback, terminal-failure retry,
  optimization rollback, or arbitrary cycles. Rejected and inconclusive verifier nodes fail the
  current run.
- It does not give a model verifier filesystem, shell, browser, network, MCP, package, skill,
  extension, or custom tools.
- It does not claim evidence delimiters prevent prompt injection or that a probabilistic verdict is
  equivalent to deterministic verification.
- It does not persist Pi, OMP, Prime, provider-SDK, or RL-environment types.
- It does not add opaque session continuation or automatic retry after an interrupted verifier.
- It does not add external verifier packages or manifests; Gate 6 can implement those against the
  new Flow-owned port.
- It does not remove or reinterpret historical command-bound criterion verification.

### Failure modes

- **Invalid declaration** — Unknown fields, mismatched driver shapes, empty or oversized prompts,
  duplicate/self/unknown/non-direct evidence, incompatible fields, invalid model/command settings,
  and invalid terminal criterion bindings fail compilation before execution.
- **Missing or truncated source evidence** — The verifier attempt fails before provider invocation.
  No partial value reaches the model and no dependent node is released.
- **Aggregate input overflow** — Canonical rendered prompt input above 256 KiB fails before provider
  invocation even when every individual source field is valid.
- **Model rejection** — A strict complete response with `rejected` becomes typed rejected evidence
  and a side-effect-free non-retryable node failure.
- **Model inconclusive response** — An explicit `inconclusive` verdict becomes typed inconclusive
  evidence and a side-effect-free non-retryable node failure.
- **Malformed/truncated model output** — Extra prose, code fences, unknown keys, invalid JSON,
  invalid verdicts, empty/oversized reasons, or output truncation cannot become acceptance. Bounded
  raw output and usage remain evidence when available.
- **Provider outage or timeout** — The node fails inconclusively, preserves bounded model evidence
  and usage when available, and never falls back to another model implicitly.
- **Command rejection** — Normal non-zero exit becomes rejected verifier evidence and preserves the
  command failure's conservative side-effect status.
- **Command infrastructure uncertainty** — Timeout, signal, sandbox, spawn, cleanup, platform, or
  missing evidence becomes inconclusive and preserves the underlying side-effect status.
- **Cancellation** — Existing run cancellation wins; a verifier cannot translate cancellation into
  a verdict that releases dependents.
- **Crash after start** — The open attempt remains uncertain under existing recovery rules. Resume
  does not repeat a model or command verifier automatically.
- **Resource exhaustion** — Node starts, model usage, reported cost, and active time continue through
  the existing durable budget accounting and precedence rules.

### Interface contract

Model driver:

```yaml
- id: review-change
  type: verifier
  dependsOn: [diff, tests]
  verifier:
    kind: model
    prompt: Decide whether the evidence proves the change is correct.
    evidence:
      - { nodeId: diff, field: command.stdout }
      - { nodeId: tests, field: command.stdout }
    model:
      provider: anthropic
      id: claude-sonnet-4-5
      thinking: medium
    timeoutMs: 120000
```

Deterministic driver:

```yaml
- id: verify-tests
  type: verifier
  dependsOn: [implement]
  verifier:
    kind: command
    command:
      executable: npm
      args: [test]
      timeoutMs: 120000
```

The source schema is a strict discriminated union. A model verifier declares 1–16 unique ordered
direct-dependency sources, a trimmed 1–16384 character rubric prompt, exact model selection, and a
bounded timeout. A command verifier declares the existing argv-only command shape and no model
fields. Both are guarded nodes and are valid inside a bounded loop body. Command-verifier approval
is not introduced in this slice.

The model receives a dedicated immutable Flow verifier system prompt, the author rubric, and
canonical JSON evidence records delimited and labeled as untrusted data. The complete rendered UTF-8
input is capped at 262144 bytes. Pi discovery remains locked off and the session tool set is empty.
The assistant must return exactly one strict JSON object:

```json
{"verdict":"accepted|rejected|inconclusive","reason":"bounded non-empty text"}
```

Surrounding JSON whitespace is accepted; Markdown fences, leading/trailing prose, unknown keys, or
additional values are not. The raw response is bounded to 16384 UTF-8 bytes, the reason to 4096
characters, and all stored strings carry SHA-256 integrity.

Flow-owned verifier evidence records:

```text
kind=verifier, driver, verdict, reason, reasonHash, raw, rawHash, rawTruncated,
durationMs, optional usage, command/model provenance,
ordered [{sourceNodeId, sourceAttempt, sourceField, sourceHash}]
```

The original source values remain on their node attempts. Verifier evidence stores their immutable
identities and hashes, not another copy. Command-driver evidence nests the existing bounded command
evidence when available. Model-driver evidence records provider/model and never policy decisions or
effect receipts because no tools exist.

An `accepted` verdict is the only legal verifier evidence for `node_succeeded`. A `rejected` or
`inconclusive` verdict is the only legal verifier evidence for `node_failed`; its failure code and
side-effect status must match the driver result. Goals may bind terminal command or verifier nodes
for backward compatibility. Criterion evaluation projects verifier verdicts directly and remains a
pure domain transition.

Verifier fields `verifier.verdict` and `verifier.reason` become typed evidence-source fields for
later approvals, model verifiers, conditions, and loop checks. Under current fail-stop semantics,
only accepted verifier evidence can release a dependent; fallback consumption of rejected evidence
is deferred.

### User, operator, and system flows

#### User: independent model review

1. Evidence-producing direct dependencies succeed and the current executable wave quiesces.
2. Flow resolves the exact complete source attempts, verifies hashes and aggregate input bounds,
   starts the verifier attempt, and invokes a zero-tool Pi session.
3. The model returns one strict verdict object.
4. Flow persists the raw output, parsed verdict, reason, source identities, usage, and duration.
5. Only an accepted verdict succeeds the node and releases graph-declared dependents.

#### User: deterministic verifier

1. A command verifier starts through the normal bounded scheduler and production command sandbox.
2. Exit zero becomes accepted; normal non-zero becomes rejected; infrastructure ambiguity becomes
   inconclusive.
3. Flow wraps the existing command evidence without weakening containment provenance, output
   integrity, or side-effect classification.

#### System: replay and recovery

1. `run_started` persists the verifier declarations in the bounded control-graph projection.
2. Replay validates event evidence integrity, driver configuration compatibility, source order,
   attempts, fields, hashes, verdict/outcome consistency, and resource accounting.
3. Recovery validates the supplied compiled workflow against the persisted digest and graph.
4. A committed verifier outcome is never reinvoked; an open attempt remains fail-closed.

## Coupling analysis

```text
verifier YAML -> compiler -> verifier node -> persisted control graph
                                             |
durable source evidence -> scheduler input binding -> VerifierExecutor port
                                             |              |
                                   command driver         Pi model driver
                                             |              |
                                             +-- typed verifier evidence --+
                                                                            |
ledger/reducer <- outcome consistency <- goal evaluator <- scheduler terminalization
```

- Workflow domain owns strict declarations, field compatibility, finite loop remapping, and the
  compiled provider-neutral node shape.
- Application owns exact source projection, aggregate input binding, scheduling, and the
  `VerifierExecutor` port.
- Infrastructure owns command/Pi invocation and translation into Flow verifier evidence.
- Run domain owns evidence schemas, hashes, verdict/outcome legality, replay, and resource totals.
- Goal domain owns only criterion-to-verdict projection and final acceptance.
- Pi, OMP, Prime, package, tool, and provider types cannot cross the port into persisted contracts.

## Approaches considered

| Approach | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Driver-explicit verifier node with command and model drivers | One typed verdict contract; deterministic baseline plus provider-neutral independent review; extensible port | Adds evidence/replay surface and a probabilistic authority users must understand | **Selected** |
| Treat selected ordinary agents as verifiers | Minimal schema work | Agent text has no strict verdict, may have tools, and blurs implementation with acceptance authority | Rejected |
| Keep only command-bound goal criteria | Smallest and strongest deterministic semantics | Does not satisfy first-class verifier/evaluator extensibility or evidence-isolated review | Rejected |
| Add only a model verifier driver | Small initial feature | Makes the new abstraction look inherently probabilistic and misses a common typed deterministic contract | Rejected |
| Embed Prime Verifiers directly | Rich environment/reward ecosystem | Python/RL coupling, larger trust/runtime surface, and provider types leak toward core | Deferred behind a future package adapter |
| Let rejected verifier nodes succeed with a separate verdict | Enables immediate remediation branches | Requires new failure-edge/dependency semantics and can make graph success ambiguous | Deferred to general failure/fallback routing |

## Decision

Add a first-class guarded `verifier` node with explicit `command` and `model` drivers. Both emit one
Flow-owned typed verifier evidence shape. Model evaluation is isolated to declared immutable
evidence, a dedicated system prompt, an empty tool surface, strict JSON, and hard input/output
bounds. Command evaluation reuses the production sandbox and preserves its evidence and side-effect
classification. Only accepted evidence succeeds; rejected or inconclusive evidence fails closed.
Persist verifier declarations and source identities so replay proves the verdict without provider
access. Preserve legacy command-bound goals and prefer deterministic verification for release
claims.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict driver/source contract | Contract | `npx vitest run test/unit/workflow/verifier-node-compiler.test.ts` | Valid command/model nodes compile; bounds and incompatible sources reject; loops remap exactly | Package verifiers |
| Strict verdict/evidence integrity | Domain/adversarial | `npx vitest run test/unit/run/verifier-node-reducer.test.ts` | Hash, source, verdict/outcome, provenance, failure, and usage mutations reject | Provider correctness |
| Driver translation | Unit | `npx vitest run test/unit/application/verifier-executor.test.ts` | Command and Pi results map to accepted/rejected/inconclusive without lost evidence or authority | Prompt-injection immunity |
| Scheduler and recovery | Application | `npx vitest run test/unit/application/run-workflow-verifier.test.ts` | Exact input binding, no-tool invocation, quiescence, cancellation, budgets, omission, replay, and open-attempt refusal | Failure fallback |
| Goal decisions | Domain/application | `npx vitest run test/unit/goal/evaluator.test.ts test/unit/application/run-workflow-verifier.test.ts` | Terminal accepted verifier accepts; rejected/inconclusive cannot accept | Deterministic equivalence of model verdicts |
| Attached and detached composition | Integration | `npx vitest run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts -t "verifier node"` | Real JSONL run/inspect/replay paths preserve typed evidence without live credentials | Host reboot recovery |
| Public contract | Documentation | `npx vitest run test/scaffold/community-files.test.ts` | README/spec/architecture/security/recovery/testing/roadmap/example match executable behavior | TUI |
| Complete package | Regression/release | `npm run check`; coverage; runtime; package; audit; `actionlint` | Clean source/runtime/package/security gates | Hosted CI availability |

## Planned RED → GREEN → REFACTOR sequence

1. **Schema/compiler RED** — Add valid drivers, strict bounds, evidence compatibility, criterion,
   branch, loop-remapping, control-graph, and legacy-shape tests.
2. **Schema/compiler GREEN** — Add source/compiled types, discriminated schemas, diagnostics,
   freezing, loop expansion, and persisted graph projection.
3. **Verifier evidence RED/GREEN** — Add provider-neutral verdict, source observation, integrity,
   resource, and outcome-consistency schemas and reducer tests.
4. **Executor RED/GREEN** — Add the port, canonical input renderer, strict verdict parser, command
   translation, and zero-tool Pi model translation with isolated unit fakes.
5. **Scheduler RED/GREEN** — Bind exact source attempts, enforce input/truncation limits, schedule
   verifier nodes, and preserve concurrency, cancellation, budget, and recovery invariants.
6. **Goal RED/GREEN** — Allow terminal verifier bindings and project typed verdicts without changing
   legacy command decisions.
7. **Composition RED/GREEN** — Exercise attached CLI and detached workers with deterministic fake
   model runners and real JSONL replay.
8. **VERIFY** — Update all public docs and examples; run mutation probes, adversarial review, full
   source/compiled/runtime gates, coverage, package install, dependency audit, and action lint.

## Primary references

- Pi SDK and coding agent: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- OMP advisor isolation: <https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md>
- Prime Agent gate semantics: <https://github.com/PrimeIntellect-ai/prime-agent>
- Prime Verifiers: <https://github.com/PrimeIntellect-ai/verifiers>
- Existing deterministic goal decision: `.decisions/issue-4.md`

## Implementation tasks

1. [x] Compile strict command/model verifier nodes and persist their graph contract.
2. [x] Persist typed verifier evidence and enforce replay/outcome/resource invariants.
3. [x] Implement canonical evidence binding and command/zero-tool Pi verifier drivers.
4. [x] Integrate scheduler, goals, loops, conditions, approvals, budgets, cancellation, and recovery.
5. [x] Add attached/detached integration, public examples, and complete documentation.
6. [x] Run full runtime, package, coverage, audit, mutation, and adversarial verification.

## Verification result

Implemented on 2026-08-08. The final adversarial pass added fail-closed handling for duplicate JSON
keys, truncated source replay, late cancellation, adapter exceptions, impossible zero-tool activity,
provider/model provenance mismatch, inconsistent command outcomes, deterministic reason mutation,
and committed command side-effect lower bounds.

- Source suite: 66 files, 891 tests passed.
- Compiled runtime suite: 3 files, 20 tests passed.
- Coverage: 84.06% statements, 77.70% branches, 93.26% functions, 84.15% lines.
- Type checking, linting, tracked/new-file formatting, production build, package verification,
  `actionlint`, example validation, and dependency audit passed.
- Dependency audit: zero reported vulnerabilities.

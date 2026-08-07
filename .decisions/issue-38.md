# Decision Journal: Issue #38 — Pause workflows at durable evidence-bound approval nodes

**Issue**: #38 | **Branch**: `codex/issue-38-durable-approval-nodes` | **Started**:
2026-08-07

---

## Init

### Context and invocation reason

Gate 5 requires a graph-visible approval node. Flow already has a durable exact command approval
protocol: request an immutable command operation, detach while waiting, grant or deny under an
exclusive store claim, expire unused grants, and consume a grant at exactly one command start. That
protocol proves the storage, replay, ownership, CLI, and supervisor mechanics, but its operation and
two-phase grant semantics are command-specific.

A general graph gate has different authority. It does not authorize a future process or tool call.
It asks an operator to accept or reject a declared review prompt over exact already-durable
evidence, then completes or fails one pure control node. The design must preserve this distinction
so a graph approval cannot be mistaken for command authorization, sandbox permission, dynamic tool
consent, or authenticated remote identity.

### Current invariants

- The compiled graph is finite and acyclic, has exactly one entry, and ends in deterministic command
  evidence.
- Control nodes never emit `node_started`, never invoke an executor, and consume no executor budget.
- Command and agent evidence is bounded, hash-bearing, typed, and records truncation.
- A run may have at most one scheduler-selected pending approval request under the current
  declaration-ordered, quiescent transition model.
- `waiting_for_approval` survives client and detached-worker exit; a later decision exclusively
  claims the same run store.
- Command approval request ids are sequence-derived locators, not authentication secrets. Actor
  labels are bounded attribution, not identity proof.
- Recovery validates committed control transitions against the canonical next scheduler transition.
- Conditions, joins, loops, omission, concurrency, budgets, cancellation, goals, and recovery retain
  independent authority.

## Research findings

- GitHub Actions environment protection holds a job and withholds protected secrets until a
  required reviewer approves. This supports treating approval as an authority barrier before
  downstream capability becomes available, not as post-hoc audit metadata.
- AWS Step Functions callback tasks durably pause a state-machine execution until the exact task
  callback succeeds or fails. Flow should reuse the durable graph-wait shape, but not introduce a
  bearer task token or remote service boundary in this local slice.
- OMP resolves allow/prompt/deny for an exact tool call and fails or cancels when an interactive
  permission channel is unavailable. That is appropriate for a live inner tool loop, but it does
  not provide provider-neutral outer-graph replay after process exit.
- Flow's existing command approval demonstrates that decision persistence and operation execution
  must remain separate. Its grant TTL closes a time-of-check/time-of-use window before command
  start. A pure approval node has no later operation, so approval can terminalize the node in the
  same committed event and needs no grant or expiry state.
- Flow's exact condition and loop source helpers already project typed command/agent evidence into
  `{attempt, value, hash, truncated}` observations. The approval contract should reuse that shape
  while keeping a dedicated digest domain and event vocabulary.

## Specification

### Non-goals

- This slice does not approve a command operation, increase sandbox or policy authority, or replace
  exact command approval.
- It does not suspend or resume a Pi/provider session or approve an in-flight model tool call.
- It does not add remote callbacks, bearer tokens, authentication, RBAC, reviewer groups, quorum,
  self-review rules, signatures, or multi-party policy.
- It does not accept incomplete or truncated evidence, mutable paths without content evidence, or
  implementation rationale that is absent from the ledger.
- It does not add general verifier nodes, optimization policy, child runs, fallback/retry behavior,
  dynamic fan-out, artifacts, or new sandbox profiles.
- It does not let an approval request overlap running executable work. The existing quiescent
  control barrier remains.

### Failure modes

- **Invalid declaration** — Empty/oversized prompts, empty/oversized evidence lists, duplicate
  evidence declarations, unknown sources, self-reference, non-direct sources, incompatible fields,
  or invalid branch dependencies fail compilation with structured paths.
- **Truncated evidence** — Request creation fails as typed, side-effect-free control failure. No
  operator is asked to approve a partial observation.
- **Missing/omitted evidence** — A selected approval node requires successful evidence for every
  declaration. An omitted enclosing branch propagates dependency omission without a request.
- **Forged request** — Replay recomputes prompt, ordered source identity, attempts, fields, hashes,
  canonical digest, and sequence-derived request id from the persisted graph and node evidence.
- **Stale or duplicate decision** — A decision must name the one current pending request. A stale,
  already-decided, or terminal request appends nothing.
- **Approval** — One committed approval immediately succeeds the pure node. It emits no start,
  consumes no command grant, and releases only graph-declared dependents.
- **Denial** — One committed denial fails the pure node with exact non-retryable,
  side-effect-free evidence. The run terminalizes without an executor invocation.
- **Decision append failure** — The pending request remains authoritative and ownership is released;
  the operator may safely retry the same decision.
- **Crash after decision** — Replay observes the committed node result and never requests or decides
  again. If run terminalization was not committed after denial, resume repairs only that boundary.
- **Cancellation** — Cancellation while waiting uses the existing run cancellation authority and
  cannot be converted to approval or denial.
- **Budget exhaustion** — Pure request/decision events consume no execution budget, but prior
  exhausted resources retain precedence and prevent reaching the gate.
- **Legacy ledger** — Historical command-only approval events and run states retain their exact
  semantics and replay shape.

### Interface contract

```yaml
- id: review-plan
  type: approval
  dependsOn: [plan, verify-plan]
  approval:
    prompt: Approve this verified implementation plan before workspace mutation.
    evidence:
      - nodeId: plan
        field: agent.text
      - nodeId: verify-plan
        field: command.stdout
```

`prompt` is trimmed, non-empty, and bounded to 4096 characters. `evidence` contains 1 through 16
unique ordered declarations. Each source is a direct dependency, is not the approval node, and is a
compatible command or agent node. Source values remain in their original bounded node evidence;
the approval request stores immutable references and hashes rather than duplicating large text.

The request snapshot is versioned and contains:

```text
version, runId, workflowId, workflowDigest, nodeId, attempt=1, prompt,
ordered [{sourceNodeId, sourceAttempt, sourceField, sourceHash}]
```

Its SHA-256 digest uses a dedicated canonical function. The request event stores the snapshot,
digest, and a sequence-derived id. Approval and denial events repeat the request id/digest and add a
validated actor plus an optional denial reason. Approval succeeds the node immediately. Denial
fails it immediately. There is no graph-approval grant, expiry, consumption, or `node_started`.

The existing `flow approve` and `flow deny` commands inspect the pending typed request and dispatch
to its protocol. They do not require the mutable workflow file. Run and inspect output expose the
request kind, immutable references, status, actor, and decision timestamps.

### User, operator, and system flows

#### User: approve a verified plan

1. Upstream plan and deterministic verification nodes settle and the executable wave quiesces.
2. Flow projects complete evidence, persists one exact request, returns
   `waiting_for_approval`, and releases ownership.
3. The operator inspects the prompt and source evidence, then approves the request id.
4. Flow exclusively claims the run, verifies the pending request, appends one approval event, and
   succeeds the pure node.
5. A later `resume` advances only graph-declared downstream work.

#### Operator: deny unsafe continuation

1. The operator denies the exact pending request with an optional bounded reason.
2. Flow persists actor, reason, request identity, and exact typed node failure.
3. The run fails without any approval-node start or downstream execution.

#### System: recover around the wait

1. A committed request replays to the same wait and is not regenerated.
2. A failed decision append leaves the request pending and can be retried safely.
3. A committed approval replays to a succeeded control node; a committed denial replays to a failed
   control node and resume repairs only a missing run terminal event.

## Coupling analysis

```text
approval YAML -> compiler -> compiled approval node -> control-graph projection
                                                        |
durable evidence -> request snapshot/digest -> request event -> waiting run
                                                        |
CLI decision -> exclusive claim -> typed approve/deny event -> reducer -> graph continuation
```

- Workflow domain owns declaration bounds, source compatibility, and compiled node shape.
- Approval domain owns snapshot canonicalization, request ids, actor/reason bounds, and digests.
- Run events/reducer own request and decision legality, immutable node state, and replay.
- Scheduler owns evidence projection and request publication, but no human decision.
- Decision application owns exclusive claim/append/release and routes by pending request kind.
- CLI and supervisor remain transports; they cannot synthesize requests or graph transitions.
- Command/agent executors, Pi, sandbox, effect journal, and policy broker remain unchanged.

## Approaches considered

| Approach | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Dedicated pure approval node and events | Explicit graph semantics; preserves legacy command approval; no TOCTOU grant | Adds a second typed request family and routing logic | **Selected** |
| Widen command operations/events into a generic tagged union | Maximum apparent event/helper reuse | Couples pure decisions to command expiry/consumption; larger historical migration surface | Rejected for the public contract; private helpers may be shared |
| External callback task token | Natural remote integration; familiar Step Functions model | Requires authenticated routing, token secrecy, expiry, and supervisor/API surface | Deferred |
| Provider/ACP interactive prompt | Good live model UX | Provider/session coupled; headless waits cannot survive exit | Rejected as outer graph authority |
| Mutable workspace checkpoint without evidence snapshot | Small schema and UI | Cannot prove what the operator reviewed; replay is weak | Rejected |

## Decision

Add a strict pure `approval` node with one bounded prompt and 1–16 exact evidence declarations.
Persist a dedicated versioned request snapshot and digest over complete durable evidence. Reuse the
existing run wait status, ownership, CLI verbs, and supervisor lifecycle, while adding dedicated
request/approve/deny events that immediately terminalize the pure node. Preserve command approval
events and their grant/expiry/consumption semantics unchanged.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict declaration/source contract | Contract | `npx vitest run test/unit/workflow/approval-node-compiler.test.ts` | Valid nodes compile; bounds, duplicate/unknown/incompatible/non-direct sources reject; legacy snapshots stay equal | Dynamic tool approval |
| Exact request digest | Evidence/adversarial | `npx vitest run test/unit/run/approval-node-reducer.test.ts -t "request|forged"` | Prompt and ordered source attempt/field/hash/digest/id are recomputed; mutations reject | Authentication |
| Durable approve/deny | State machine | `npx vitest run test/unit/application/run-workflow-approval-node.test.ts -t "approval|denial|duplicate|append"` | Exact request decides once; approval succeeds node; denial fails closed; append failures retry | Multi-party review |
| Scheduler barrier/recovery | Behavioral/recovery | `npx vitest run test/unit/application/run-workflow-approval-node.test.ts` | One quiescent request, no executor entry, resume never duplicates request/decision | In-flight session suspension |
| Conditions, loops, budgets, cancellation, goals | Integration/safety | `npx vitest run test/unit/application/run-workflow-approval-node.test.ts test/unit/run/approval-node-reducer.test.ts` | Branch omission never prompts; loops, quiescent concurrency, cancellation, budgets, and goals retain authority | Failure fallback |
| CLI and detached wait | Runtime | `npx vitest run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts -t "approval node"` | Run exits waiting, inspect matches replay, decision + resume continues, detached worker releases | Remote callbacks |
| Public contract | Documentation | `npx vitest run test/scaffold/community-files.test.ts` | README/docs describe implemented distinctions and limits | TUI |
| Complete package | Regression/release | `npm run check`; coverage; package; audit; `actionlint` | Clean source/runtime/package/security gates | Hosted CI availability |

## Planned RED → GREEN → REFACTOR sequence

1. **Schema/compiler RED** — Add strict valid, bound, source, control-flow, legacy-shape, and loop
   expansion tests.
2. **Schema/compiler GREEN** — Add source/compiled node types, diagnostics, freezing, graph
   validation, control projection, and size limits.
3. **Approval domain RED/GREEN** — Add canonical request snapshot, digest, id, actor, and reason
   contracts independently of run events.
4. **Reducer RED/GREEN** — Add strict request/approval/denial events, replay invariants, node state,
   and backward-compatible command approval.
5. **Scheduler RED/GREEN** — Add quiescent request selection, evidence projection, truncation
   failure, omission propagation, and executor non-entry.
6. **Decision service RED/GREEN** — Route the existing CLI decision surface by pending typed request
   and prove crash/duplicate/stale behavior.
7. **Composition RED/GREEN** — Exercise attached and detached wait, inspect, decision, and resume with
   real JSONL ownership.
8. **VERIFY** — Update public docs; run mutation probes, adversarial diff review, full source and
   compiled runtime, coverage, package install, audit, and workflow syntax.

## Primary references

- GitHub Actions deployment protection and required reviewers:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>
- AWS Step Functions callback task tokens:
  <https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html>
- OMP approval mode and tool-call policy:
  <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md>
- Existing Flow exact command approval decision: `.decisions/issue-18.md`

## Implementation tasks

1. [x] Compile strict approval nodes and persist their control-graph contract.
2. [x] Canonicalize exact evidence-bound requests and replay request/decision facts.
3. [x] Integrate scheduler waits, omission, truncation, goals, loops, budgets, and cancellation.
4. [x] Route attached/detached CLI approval decisions without changing command approval semantics.
5. [x] Update all public capability, safety, recovery, testing, and roadmap documentation.
6. [x] Run full runtime, package, coverage, audit, mutation, and adversarial verification.

## Verification results

### Acceptance evidence

| Criterion | Result | Evidence |
| --- | --- | --- |
| Strict declaration and compiled graph | Pass | `test/unit/workflow/approval-node-compiler.test.ts`: valid command/agent sources, empty/duplicate/unknown/self/non-direct/incompatible/oversized declarations, branch compatibility through the shared compiler, and bounded-loop remapping |
| Canonical request and replay | Pass | `test/unit/run/approval-node-reducer.test.ts`: exact request/decision reconstruction plus forged id, prompt, attempt, field, hash, digest, non-canonical prompt, truncation, executor-start, denial, and cancellation rejection/transition cases |
| Scheduler, decision, and recovery | Pass | `test/unit/application/run-workflow-approval-node.test.ts`: request, approve, deny, stable pending resume, duplicate decision, append retry, crash repair, truncation, branch omission, concurrent quiescence/order, loop omission, budget, and goal behavior |
| CLI and detached worker | Pass | Focused CLI/worker command passed two tests; JSONL request/decision/resume and detached exit-3 ownership release are asserted |
| Public contract | Pass | README, architecture, workflow spec, recovery, testing, security, capability sourcing, roadmap, and `examples/evidence-approval.workflow.yaml`; community-file tests pass |

### Full gates

- `npm run lint`: clean, no warnings.
- `npm run typecheck`: clean.
- `npm test`: 62 files and 821 tests passed.
- `npm run build`: clean production build.
- `npm run test:runtime`: clean compiled-process/runtime suite.
- `npm run test:coverage`: 84.50% statements, 77.85% branches, 93.08% functions, and 84.63%
  lines.
- `npm run pack:check`: clean tarball installation and installed CLI execution; package policy
  digest `5818be92618d24b2680a89bfae4a3b6678f7190cc93f06d02de90a797ef52c85`.
- `npm audit --omit=dev`: zero vulnerabilities.
- `actionlint`: clean.
- Compiled CLI validates `examples/evidence-approval.workflow.yaml` as three nodes and zero criteria.
- `git diff --check`: clean.

`npm run format:check` inspects untracked local files and reports only a missing final newline in the
user-owned `.codex/hooks.json`. That file is outside Issue #38 and remains untouched. The same root
scan reports no repository or feature-file formatting issue; all changed and added files were also
formatted explicitly.

### Adversarial review dispositions

1. **Resolved — canonical event authority.** Event replay previously let Zod trim surrounding
   request-prompt whitespace. The event/control-graph schemas now require canonical prompt bytes;
   workflow-source compilation remains the sole normalization boundary. A mutation test proves
   non-canonical ledger input rejects.
2. **Resolved — isolated size-bound proof.** The initial 17-source test also contained duplicate and
   incompatible declarations. It now constructs 17 unique, type-compatible direct dependencies in
   an otherwise valid single-entry graph, so the evidence-count ceiling is the only failing rule.
3. **No open findings.** Spec compliance, security, correctness, performance, conventions, tests,
   error handling, and claim/file cross-checks converged with no P1, P2, or P3 items.

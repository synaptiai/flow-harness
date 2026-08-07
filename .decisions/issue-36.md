# Decision Journal: Issue #36 — Execute replay-safe bounded workflow loops

**Issue**: #36 | **Branch**: `codex/issue-36-replay-safe-bounded-loops` | **Started**:
2026-08-07

---

## Init

### Context and invocation reason

Gate 5 requires executable bounded loops. Issue #32 added exact-output conditions, guarded
branches, omission, and explicit joins. Issue #34 added deterministic bounded concurrency for
static DAG forks. The remaining loop gap cannot be filled by merely allowing a dependency cycle:
the durable run model intentionally stores one state per compiled node, uses `attempt` only for
proof-safe recovery, and rejects cycles before execution.

The desired outcome is a real harness primitive rather than a prompt convention. Loop bounds,
iteration identity, stop evidence, omissions, budgets, approvals, effects, and recovery therefore
remain Flow-owned and replay-authoritative. Pi continues to own only the inner provider/tool turn
loop for an agent node.

### Current invariants

- Every executable node instance has one durable state slot and a monotonic attempt number.
- `node_started` is appended and synchronized before an executor may run.
- The compiled graph is finite and acyclic, has exactly one entry, and ends at command evidence.
- Exact conditions use non-truncated durable command or agent output and persist its hash.
- Pure control transitions cannot overlap a running executable wave.
- Command approval, fresh agent recovery, effects, and budgets are keyed by compiled node id and
  attempt.
- A workflow digest and complete control graph can be persisted at run start and validated without
  reopening mutable YAML.
- Concurrent scheduling admits deterministic, declaration-ordered, quiescent waves.

## Research findings

- Pi Autoresearch demonstrates a useful optimization interaction: initialize a metric and
  direction, run an experiment, record keep/discard/crash/checks-failed, preserve compact JSONL
  memory, and continue. Its current implementation enforces `maxIterations` at the experiment tool
  and after logging, but its in-memory result is updated before Git commit and JSONL append, and Git
  rollback failures are reported rather than transactionally reconciled. Flow should reuse the
  product shape, not treat that ordering as a durable workflow protocol.
- Pi Autoresearch also has a separate 200-turn auto-resume guard and a consecutive-failure guard.
  That confirms iteration, model turns, and stagnation are different dimensions and should not be
  collapsed into one counter.
- Prime Agent separates persistent goals from autonomous continuation policy. Its host enforces
  continuation, turn, token, wall-clock, and quality-gate bounds and avoids rerunning the same
  failed gate when the worktree has not changed. Flow should retain that host-authority principle
  while persisting the resulting decisions in its ledger rather than session memory.
- OMP bounds recursive task spawning with a maximum depth and uses a session semaphore, explicit
  cancellation, isolated child workspaces, and a quiescence barrier. Those are proven child-task
  mechanics, not a replayable outer graph-loop state machine.
- LangGraph permits graph cycles but stops at a configurable recursion/superstep limit. That is a
  useful last-resort safety guard, but a global step count cannot explain which Flow loop converged,
  stagnated, or exhausted its own declared contract.
- AWS Step Functions keeps bounded inline iterations in the parent execution history and moves
  large distributed maps into child histories. Standard workflows persist state between
  transitions; history size is explicitly bounded.
- Temporal Continue-As-New checkpoints state into a fresh execution with the same workflow id and a
  new run id. This is the right later pattern for very long or unbounded work, not a dependency for a
  deliberately small bounded loop.
- Earendil's Pi case study argues that harness context discipline matters independently of model
  choice. Flow should add loop authority as deterministic host state and compact evidence, not as a
  large changing prompt or provider-specific continuation protocol.

## Specification

### Non-goals

- This slice does not permit arbitrary graph cycles, nested loops, unbounded loops, recursion,
  dynamic maps, child runs, or Continue-As-New history rotation.
- It does not yet implement an optimization-loop contract containing a numeric metric, baseline,
  direction, invariants, stagnation policy, accept-best semantics, workspace snapshot, or automatic
  rollback. Those require a distinct contract and stronger workspace/child-run semantics.
- It does not add general verifier nodes, general approval nodes, failure/fallback retries, or
  provider-owned opaque session continuation.
- It does not let one loop iteration overlap another. Existing bounded DAG concurrency remains
  available inside the active iteration.
- It does not treat reaching the hard iteration bound as success. A missing stop decision fails
  closed.
- It does not promise exactly-once effects in external systems or rollback of arbitrary workspace
  mutations.
- It does not pass loop state, sibling graph structure, or termination authority into Pi or a node
  executor.

### Failure modes

- **Invalid bound** — Missing, fractional, non-positive, or greater-than-32 `maxIterations` values
  fail schema validation before expansion.
- **Oversized expansion** — More than 256 compiled nodes, more than the control-graph byte limit, or
  an iteration-qualified identifier longer than the durable 128-character limit fails compilation.
- **Invalid body graph** — An empty body, more than 16 body nodes, multiple entries, cycles,
  duplicate or cross-scope dependencies, invalid conditions/joins, or nested loops fails
  compilation with a path inside the loop body.
- **Ambiguous stop source** — The `until` source must be a compatible command/agent evidence field
  and must execute on every successful body path. A source inside a conditional branch, outside the
  body, or not awaited by every body terminal fails compilation.
- **Truncated stop evidence** — A loop check over truncated output becomes a typed control failure;
  truncated text can never satisfy or refute the stop contract.
- **Body node failure** — The current iteration quiesces under the existing failure rules and the
  run fails. No later iteration is admitted.
- **Bound exhausted** — If the last loop check says continue, the loop controller fails with
  `loop_limit_reached`; downstream nodes and approvals never start.
- **Early stop** — The first matching check is authoritative. Every later expanded iteration is
  durably omitted and invokes no executor, approval, provider, sandbox, or effect path.
- **Unselected enclosing branch** — If the loop belongs transitively to an unselected condition
  branch, body checks and the controller propagate dependency omission. The controller does not
  report false bound exhaustion.
- **Budget exhausted** — Existing run resource exhaustion has authority. It cannot be converted to
  loop success or loop-limit failure, and no next iteration starts after exhaustion.
- **Approval wait** — An approval-required command instance waits under its exact qualified node id
  and attempt. Other work quiesces before the request, and resume consumes that exact grant once.
- **Interrupted executable** — Recovery addresses the open iteration-qualified instance. Completed
  earlier iterations and loop-check decisions remain terminal and are never repeated.
- **Interrupted control transition** — If no loop-check event was committed, replay deterministically
  selects it again from already-durable evidence. If it was committed, replay never re-evaluates it.
- **Forged iteration order or shape** — Reducer validation rejects a body start whose prior loop
  check did not continue, a later-iteration start after stop, mismatched source hashes/attempts,
  unregistered or duplicate checks, structural drift between body clones, stop-contract drift,
  invalid omissions, or a controller completion inconsistent with its checks.
- **Cancellation** — The active wave reaches the existing quiescent cancellation boundary. No later
  iteration or loop control completion is appended after terminal cancellation.
- **Legacy workflow/run** — Workflows without loops preserve their current compiled form and digest.
  Historical ledgers replay without loop metadata.

### Interface contracts

An author declares a top-level loop node with a nested local DAG:

```yaml
- id: repair
  type: loop
  dependsOn: [prepare]
  loop:
    maxIterations: 4
    until:
      source:
        nodeId: check
        field: command.stdout
      equals: pass
    body:
      nodes:
        - id: fix
          type: agent
          agent:
            prompt: Repair the failing implementation.
            model:
              provider: anthropic
              id: claude-sonnet-4-6
            tools: [read, ls, edit]
        - id: check
          type: command
          dependsOn: [fix]
          command:
            executable: npm
            args: [test, --, --run]
```

`maxIterations` is an integer from 1 through 32. A body has 1 through 16 non-loop nodes and exactly
one entry. Body identifiers and references are local to that loop. The body may use the existing
command, agent, exact condition, guarded branch, and explicit join contracts. Nested loops are
rejected in this slice.

`until.source.nodeId` names a body command or agent whose selected field is available on every
successful body path. `equals` uses exact string equality. A match means stop successfully; a
non-match means continue unless this is the final allowed iteration. Whitespace is not normalized.

The compiler lowers the source declaration into a finite acyclic plan:

1. Every body node is cloned once per possible iteration with a deterministic qualified id such as
   `repair--i1--node--fix`.
2. Every clone carries immutable `{loopId, iteration, templateNodeId}` metadata.
3. A pure loop-check control node follows all body terminals for each iteration and records the
   exact source attempt, field, hash, and `stop` or `continue` decision.
4. Iteration one begins after the loop node's source dependencies. Each later body entry depends on
   the prior check and is eligible only when that check says `continue`.
5. The source loop id becomes a pure controller after all expanded checks are terminal. It succeeds
   from the first `stop` check or fails if the final check continued.
6. Downstream source nodes retain their dependency on the original loop id.

The total compiled plan is capped at 256 nodes. Generated ids must be unique and fit the existing
durable identifier schema. The compiler records the expanded plan in the workflow digest. When
control-graph persistence is required, it includes loop instance/check/controller metadata so
replay does not infer semantics from the id string.

Two new pure control facts are authoritative:

- `node_loop_checked` succeeds one synthetic check node and binds its decision to exact durable
  evidence.
- `node_loop_completed` succeeds the source loop controller and names the terminating check and
  number of completed iterations.

`node_omitted` gains a loop-specific reason for the first later body entry skipped after a stop.
Ordinary dependency omission then propagates through the remaining finite expansion. A typed
`node_control_failed` records truncated evidence or `loop_limit_reached` without consuming node
start, token, cost, or active-time budget.

Loop iteration and retry attempt are orthogonal:

```text
source template: repair/fix
compiled instance: repair--i3--node--fix
loop iteration: 3
attempts for that instance: 1, then optionally 2 after proof-safe interruption
```

### User, operator, and system flows

#### User: converge before the bound

1. Flow starts the first iteration body after the loop's upstream dependencies succeed.
2. Body nodes execute through ordinary approvals, budgets, policy, sandbox, effects, and bounded
   concurrency.
3. The loop check binds a `continue` decision to exact body evidence.
4. Flow starts the next qualified body instance and repeats.
5. The first `stop` decision is persisted, all future instances become omitted, the loop controller
   succeeds, and downstream work becomes eligible.

#### User: fail to converge

1. Every allowed iteration completes with a durable `continue` check.
2. The controller records `loop_limit_reached` and fails the run.
3. Inspection shows every iteration instance, source hash, decision, resource consumption, and the
   exact hard bound; no downstream verifier is invoked.

#### Operator: approve a command inside iteration three

1. The qualified iteration-three command reaches an approval barrier after prior work quiesces.
2. Flow persists the exact operation and returns a detachable wait state.
3. The operator grants or denies that request in a later client process.
4. Resume consumes only that instance's grant and continues or fails under the existing approval
   state machine.

#### System: recover an interrupted iteration

1. The new owner replays the expanded graph, loop metadata, completed checks, and current open
   instance.
2. It reconciles open typed effects and applies the existing proof-safe recovery policy to that
   exact instance and attempt.
3. If recovery is eligible, scheduling resumes within the same loop iteration.
4. If the body later completes, one new check is recorded; no earlier body instance or decision is
   repeated.

## Coupling analysis

```text
loop YAML -> source validator -> finite plan expander -> compiled workflow digest
                                     |
                                     v
                    iteration-qualified nodes + loop control metadata
                                     |
                                     v
JSONL ledger <-> pure reducer <-> deterministic scheduler -> node executor
      ^                |                    |                    |
      |                |                    |                    +-> Pi/command adapter
      |                |                    +-> approval/budget barriers
      +----------------+------------------------ effect/recovery evidence
```

- Source schema/compiler owns body scope, hard bounds, static expansion, identifier generation, and
  compatibility. It imports no executor, store, or provider code.
- Run events/reducer own legal iteration ordering, source-evidence binding, omission, controller
  completion, replay, and typed failure. They import no Pi or filesystem implementation.
- The application scheduler owns selection and publication of pure loop control transitions. It
  continues to invoke only command/agent nodes.
- Existing approval, recovery, budget, effect, policy, command sandbox, and Pi adapters remain
  node-scoped. Qualified compiled ids let those contracts apply without loop-specific authority.
- Supervisor capacity remains run/worker admission. Per-run concurrency remains executable-node
  admission. Neither becomes the loop counter.
- Later optimization loops can build on explicit loop facts, but workspace snapshot/rollback and
  numeric metric policy remain separate domains.

## Approaches considered

| Approach | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Permit arbitrary cyclic dependencies and add iteration to every event key | Familiar state-machine graphs; compact compiled graph | Rewrites node-state, approval, recovery, goal, join, and concurrency invariants; cycles can escape a declared bound | Rejected |
| First-class loop controller with dynamically-created body state | Compact history for unused iterations; natural nested runtime scope | Requires dynamic node admission, mutable node sets, new approval/recovery addressing, and more complex replay | Deferred as a possible post-v1 execution engine |
| Structured loop compiled into a finite acyclic plan | Preserves one state per instance, existing node-scoped safety, deterministic replay, and static validation | Compiled size grows with bound; internal instances are visible; requires strict expansion caps and loop control facts | **Selected** |
| One child run per iteration / Continue-As-New | Strong history and workspace isolation; supports very long loops and rollback checkpoints | Child-run protocol and isolated workspaces are not implemented; excessive for a small bounded loop | Deferred to child runs and optimization loops |
| Prompt-only Pi/Prime-style continuation | Very small harness change; leverages model reasoning | Bounds and completion are session-memory/prompt policy, not durable graph evidence; provider/runtime behavior leaks into authority | Rejected as Flow semantics |

## Decision

Add a strict top-level structured `loop` node and compile it into a deterministic finite DAG with
iteration-qualified body instances, one exact-evidence check per possible iteration, and a pure
controller under the original loop id. Keep arbitrary graph cycles invalid. Cap each loop at 32
iterations, each body at 16 nodes, and the fully expanded workflow at 256 nodes.

Execute one iteration at a time while retaining existing bounded concurrency inside it. Bind every
stop/continue decision to non-truncated durable evidence. A first stop succeeds the controller and
omits all later instances; an unsatisfied final check fails with `loop_limit_reached`. Apply all
existing approvals, budgets, recovery, effects, cancellation, and executor behavior to the
qualified executable instance without teaching executors about loops.

This slice deliberately provides the durable general loop substrate first. A later optimization
contract will add numeric metric/baseline/direction, invariants, stagnation, best-candidate
selection, and a rollback strategy only after its workspace authority can be made equally explicit.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict source contract and scope | Contract | `npx vitest run test/unit/workflow/loop-compiler.test.ts -t "schema|scope|body"` | Valid bounded local body compiles; invalid bounds, nested loops, cross-scope refs, and malformed body control reject | Nested or unbounded loops |
| Finite deterministic expansion | Contract/determinism | `npx vitest run test/unit/workflow/loop-compiler.test.ts -t "expand|identity|limit"` | Stable qualified ids and metadata; 256-node/id-size/collision limits fail closed; non-loop snapshots stay equal | Compact dynamic histories |
| Exact check replay | Evidence/adversarial | `npx vitest run test/unit/run/loop-reducer.test.ts -t "check|source|truncated|forg"` | Exact source attempt/field/hash determines one decision; mutations and truncation reject or fail typed | Semantic or numeric comparison |
| Early successful stop | Behavioral | `npx vitest run test/unit/application/run-workflow-loop.test.ts -t "stops early"` | First matching check succeeds controller and later executors/approvals/effects remain absent | Accept-best optimization policy |
| Hard-bound failure | Failure | `npx vitest run test/unit/application/run-workflow-loop.test.ts test/unit/run/loop-reducer.test.ts -t "loop_limit_reached|hard bound"` | Final continue produces typed failure and no downstream start | Success from resource exhaustion |
| Sequential iterations, concurrent body | Concurrency | `npx vitest run test/unit/application/run-workflow-loop.test.ts -t "iteration overlap|body concurrency"` | No two iterations overlap; ready siblings inside one body obey `concurrency.maxNodes` and ordered outcomes | Parallel loop iterations |
| Attempts remain distinct | Recovery | `npx vitest run test/unit/application/run-workflow-loop.test.ts -t "resume|attempt|interrupted"` | Resume addresses exact qualified instance; completed iterations/checks never repeat; fresh retry increments only attempt | Mid-turn Pi session continuation |
| Approval, effects, budgets, cancellation | Integration/safety | `npx vitest run test/unit/application/run-workflow-loop.test.ts -t "approval|effect|budget|cancel"` | Existing gates and ledgers bind qualified instances; no next iteration after wait, uncertainty, exhaustion, or cancellation | External exactly-once effects |
| Public CLI contract | Runtime/docs | `npx vitest run test/integration/cli/main.test.ts -t "bounded loop"`; `npx vitest run test/scaffold/community-files.test.ts` | Credential-free example converges and inspect/docs expose exact semantics and limitations | Optimization rollback or child runs |
| Complete package | Regression/release | `npm run check` | Formatting, lint, strict types, default tests, build, and compiled runtime tests pass | Live provider availability |
| Coverage/package/security | Release | `npm run test:coverage`; `npm run pack:check`; `npm audit --omit=dev --audit-level=low`; `actionlint .github/workflows/ci.yml` | Thresholds, clean install, production dependency audit, and workflow syntax pass | Hosted CI availability |

## Planned RED → GREEN → REFACTOR sequence

1. **Schema RED** — Add valid structured loop and strict bound/body/nesting tests; prove the current
   discriminated node union rejects `loop`.
2. **Compiler GREEN/REFACTOR** — Add source types, local-body graph validation, unconditional stop
   source analysis, finite expansion, qualified metadata, and compatibility snapshots.
3. **Reducer RED** — Add legal check/completion/omission histories and forged order, source,
   decision, truncation, exhaustion, and terminalization cases.
4. **Reducer GREEN/REFACTOR** — Add strict loop control graph/event types and pure transitions while
   preserving legacy events and one-state-per-instance.
5. **Scheduler RED** — Add early stop, hard-bound failure, sequential iterations, concurrent body,
   executor non-entry, and declaration-order tests.
6. **Scheduler GREEN/REFACTOR** — Extend transition selection and event projection without adding
   loop authority to executors.
7. **Recovery and safety RED/GREEN** — Exercise approvals, proof-safe interrupted attempts, effects,
   budgets, cancellation, repeated resume, and tampered ledgers against qualified instances.
8. **Composition/docs RED/GREEN** — Add a credential-free converging example and update every public
   capability, limitation, architecture, workflow, recovery, security, and testing surface.
9. **VERIFY** — Run focused tests after each layer, full local CI, coverage, compiled runtime cases,
   package installation, audit, targeted mutation probes, and adversarial diff review.

## Primary references

- Pi Autoresearch implementation and persisted loop state:
  <https://github.com/davebcn87/pi-autoresearch/blob/main/extensions/pi-autoresearch/index.ts>
- Pi Autoresearch JSONL reconstruction:
  <https://github.com/davebcn87/pi-autoresearch/blob/main/extensions/pi-autoresearch/jsonl.ts>
- Earendil, “Pi, Minimal and Performant”:
  <https://earendil.com/posts/pi-autoresearch-and-databricks/>
- Prime Agent autonomous host limits and quality gates:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/autonomous.ts>
- Prime Agent durable goals and long-running worker model:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md>
- OMP task concurrency, cancellation, workspace, and recursion behavior:
  <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md>
- OMP task discovery and recursive spawn gating:
  <https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md>
- LangGraph recursion limits:
  <https://docs.langchain.com/oss/javascript/langgraph/errors/GRAPH_RECURSION_LIMIT>
- AWS Step Functions state types and durable execution semantics:
  <https://docs.aws.amazon.com/step-functions/latest/dg/workflow-states.html>
- AWS Step Functions inline versus child-history map execution:
  <https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html>
- Temporal Continue-As-New:
  <https://docs.temporal.io/workflow-execution/continue-as-new>

## Implementation tasks

1. [x] Compile a strict structured loop into a bounded acyclic qualified plan.
2. [x] Persist and replay exact loop-check, omission, completion, and failure facts.
3. [x] Schedule sequential iterations with existing bounded concurrency inside each body.
4. [x] Preserve approvals, budgets, recovery, effects, cancellation, and goal semantics.
5. [x] Add a credential-free example and update all public capability/limitation documentation.
6. [x] Run full runtime, package, coverage, audit, mutation, and adversarial verification.

## Implementation and verification outcome

The selected finite-expansion design is implemented. During adversarial review, four initially
accepted or misclassified cases were converted into RED tests and fixed:

1. `node_omitted` accepted a loop omission carrying a partial condition-field group. The event
   boundary now rejects every cross-reason or partial field combination.
2. A persisted loop check could reference a valid source/controller without occupying its declared
   controller slot. Replay now requires bidirectional check registration.
3. A loop inside an unselected condition branch was misclassified as bound exhaustion. Scheduler
   precedence now distinguishes durable stop, dependency omission, and all-continued exhaustion.
4. Persisted iterations could reuse template names while changing body structure or the exact stop
   contract. Replay now compares normalized template structures and normalized stop contracts
   across every iteration.

An additional mutation probe inverted the scheduler's stop decision; loop application and replay
tests failed before the mutation was restored. Together with the RED cases above, this proves the
tests detect both event-boundary and transition-authority regressions rather than merely exercising
successful paths.

Final local evidence on 2026-08-07:

- repository-owned formatting, Biome lint, strict TypeScript, and `git diff --check`: pass;
- default test suite: 58 files and 784 tests pass;
- clean production build: pass;
- compiled runtime suite: 3 files and 20 tests pass;
- coverage suite: 58 files and 784 tests pass; 84.23% statements, 77.59% branches, 92.84%
  functions, and 84.37% lines;
- clean tarball installation and installed CLI execution: pass;
- production dependency audit: zero vulnerabilities;
- GitHub Actions workflow syntax: pass;
- credential-free bounded-loop CLI run and inspect path through the real command sandbox: pass.

The aggregate `npm run check` formatter step also inspected a user-owned untracked local
`.codex/hooks.json` file and reported its missing trailing newline. That file was deliberately not
modified or included. Every tracked repository file plus every new Issue #36 file was checked
explicitly, and all remaining `check` constituents passed.

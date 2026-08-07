# Decision Journal: Issue #32 — Durable conditional branches and explicit joins

**Issue**: #32 | **Branch**: `codex/issue-32-durable-conditional-joins` | **Started**:
2026-08-07
**Depends on**: Gate 4 stack through issue #30 / PR #31

---

## Context

Flow currently compiles a strict directed acyclic graph with one entry. The scheduler chooses the
first declaration-order node whose dependencies have succeeded, executes one node at a time, and
requires every node to succeed before the run can succeed. This already gives deterministic static
fan-out and fan-in ordering, but it cannot choose a branch, distinguish intentionally unselected
work from pending work, or prove that convergence waited for the selected path.

Gate 5 requires conditions, fork/join, bounded loops, general approvals, and verifier nodes. The
first slice must establish control-flow semantics that the later features can reuse. If conditions
are implemented as an executor callback, prompt instruction, mutable-file query, or arbitrary
JavaScript expression, replay can choose a different graph path after restart. If skipped
dependencies are treated as ordinary success everywhere, a package or downstream node can bypass
work that the graph intended to require.

Primary-source comparisons expose complementary patterns:

- Amazon States Language has explicit Choice, Pass, and Parallel control states. A Choice selects a
  declared target and fails when no rule or default matches. Parallel waits for every branch.
- Temporal requires replay to emit the same commands in the same order. Non-deterministic inputs
  must enter through recorded workflow APIs rather than inline clock, random, network, database, or
  model calls.
- Argo distinguishes Succeeded, Skipped, and Omitted tasks and supports conditional dependency
  logic. It also makes DAG fail-fast behavior explicit.
- LangGraph conditional edges can route to one or more nodes and execute multiple destinations in a
  superstep, but the routing function is user code. That flexibility is useful at an application
  boundary, not as Flow's replay authority.
- Pi owns the live provider/tool turn loop; OMP and Prime Agent can launch child agents and preserve
  sessions. None supplies a provider-neutral durable outer graph whose decisions Flow can adopt as
  authoritative facts.

## Specification

_Captured from issue #32, the Gate 5 roadmap, the existing run-ledger invariants, and primary-source
workflow-engine research on 2026-08-07._

### Non-goals

- This slice does not run ready branches concurrently. Static fan-out remains deterministic and
  sequential until a separately bounded concurrency scheduler is implemented.
- This slice does not add cycles, bounded loops, retries, fallbacks, optimization metrics, child
  runs, packages, general approval nodes, or general verifier nodes.
- This slice does not add arbitrary JavaScript, JSONPath, JSONata, CEL, regular expressions, shell
  predicates, clocks, random values, mutable-file reads, provider calls, or model calls to replay.
- This slice does not reinterpret command failure as a branch value. A failed command remains a
  failed node and retains fail-fast behavior.
- This slice does not treat agent text as verified truth. A workflow may explicitly route on the
  bounded durable text, but downstream deterministic verification remains required for acceptance.
- This slice does not add empty branches or a pass/no-op node. Every declared case has at least one
  guarded branch node and one mapped terminal before convergence.
- This slice does not change existing workflow compilation, digest, event shape, scheduling order,
  or recovery behavior when no control node is declared.

### Workflow interface contract

A condition is a pure control node. It depends directly on the node whose already-committed bounded
output it compares. The initial source fields are exact command standard output, exact command
standard error, and exact agent text. Values are compared as exact Unicode strings with no trimming,
case folding, normalization, parsing, coercion, or locale behavior.

```yaml
- id: classify
  type: command
  command:
    executable: node
    args: [scripts/classify.mjs]

- id: route
  type: condition
  dependsOn: [classify]
  condition:
    source:
      nodeId: classify
      field: command.stdout
    cases:
      - id: needs-work
        equals: "needs-work\n"
    default: already-clean
```

Case identifiers follow ordinary workflow identifier rules. A condition declares one to 32
non-default exact cases and one distinct default case. Case identifiers and exact values are
unique. The total UTF-8 bytes in comparison values are bounded by the largest supported source
output. A missing default is invalid, so runtime routing never has an implicit no-match behavior.

A branch root binds itself to exactly one case and lists the condition as a direct dependency:

```yaml
- id: implement
  type: agent
  dependsOn: [route]
  when:
    conditionId: route
    case: needs-work
  agent:
    prompt: Implement the requested change.
    model: { provider: test, id: deterministic }

- id: inspect-clean-tree
  type: command
  dependsOn: [route]
  when:
    conditionId: route
    case: already-clean
  command: { executable: node, args: [--version] }
```

`when` is a strict branch guard, not a general expression. It is legal on command, agent, and
condition nodes. The named condition must be a direct dependency and the case must exist. A false
guard durably omits the node. Any ordinary descendant with an omitted dependency is also omitted.
That propagation prevents a node from becoming runnable merely because some other dependency
succeeded.

An explicit join converges every case of exactly one condition:

```yaml
- id: converge
  type: join
  join:
    conditionId: route
    branches:
      - case: needs-work
        nodeId: verify-change
      - case: already-clean
        nodeId: inspect-clean-tree
```

The join branch list contains every possible case exactly once and names exactly one terminal for
each case. Its compiled dependencies are derived from that ordered list. The compiler proves that
each terminal belongs to its named case and that every node in the case is an ancestor of the
terminal. Cross-case dependencies are invalid before run creation. A condition has exactly one
convergence join in this slice. The join is not a terminal workflow node; ordinary downstream work
must depend on it.

The join waits until every mapped terminal is either succeeded or omitted. It succeeds only when
the terminal for the selected case succeeded and every other terminal was omitted. Its durable
decision records the controlling condition, selected case, completed terminal, and ordered omitted
terminals. If the controlling condition was itself omitted by an outer branch, the nested join is
omitted and that omission propagates normally.

### Compiled and persisted control contract

Legacy compiled nodes remain byte-for-byte equivalent when `when` is absent. New compiled condition
and join nodes are immutable provider-neutral values; Pi, OMP, and Prime Agent types do not enter the
domain model.

For a workflow containing control flow, `run_started` persists a bounded optional control contract:

- every node id and its ordered dependencies;
- every branch guard;
- each condition source, ordered exact cases, and default case;
- each join's controlling condition and ordered case-to-terminal mapping.

The workflow digest still binds the complete compiled workflow. The persisted control projection
lets the pure run reducer validate condition, omission, and join events without loading mutable YAML
or importing the compiler. Recovery separately requires the exact compiled digest and
cross-validates the same projection.

### Durable state and events

Node status expands from `{pending,running,succeeded,failed}` to
`{pending,running,succeeded,failed,omitted}`. An omitted node has no attempt, approval, executor
evidence, resource consumption, effect protocol, or effects. It retains a typed immutable omission
record naming the controlling false guard or the omitted dependencies that caused propagation.

Pure control transitions are atomic ledger events and do not invoke `NodeExecutor`:

- `node_condition_evaluated` records source node and attempt, exact source field and SHA-256,
  selected case, and evaluation timestamp; it moves the condition directly from pending to
  succeeded.
- `node_omitted` records a fixed reason plus the exact controlling or dependency evidence; it moves
  a pending node directly to omitted.
- `node_joined` records the selected case, completed terminal, and ordered omitted terminals; it
  moves a pending join directly to succeeded.
- `node_control_failed` records a side-effect-free, non-retryable typed failure when an otherwise
  valid condition cannot consume complete evidence, such as truncated command output.

These events consume no model, cost, execution-time, or external node-start budget because no
executor starts. They still have a logical control attempt of one in inspectable state. A crash
before an event leaves the transition pending and safely recomputable; a crash after it replays the
committed choice without re-evaluating any external input.

### Scheduling contract

For a pending node, the scheduler waits until all declared dependencies are terminal. It then uses
the following exhaustive order:

1. If a declared guard selected a different case, append `node_omitted`.
2. For an ordinary command, agent, or condition, if any dependency is omitted, append
   `node_omitted`.
3. For a join whose controlling condition is omitted, append `node_omitted` after all mapped
   terminals are omitted.
4. Evaluate a ready condition atomically from committed source evidence.
5. Converge a ready join only when its selected terminal succeeded and alternatives were omitted.
6. Start a ready command or agent through the existing approval, budget, effect, and executor path.

Declaration order remains the deterministic tie-breaker. The scheduler never treats omission as
success for ordinary dependency admission. A run can succeed when every node is succeeded or
omitted, but the compiler-enforced unconditional terminal command after convergence must succeed.
Goal criteria retain their existing command-verifier rules.

### Failure modes

- **Unknown, duplicate, or missing cases/default** — Reject with a path-specific compiler
  diagnostic before run creation.
- **Source is not a direct dependency or its field does not match its node type** — Reject before
  run creation.
- **Guard references a non-condition, unknown case, or non-dependency** — Reject before run
  creation.
- **Case has no guarded branch root** — Reject before run creation; no implicit empty branch exists.
- **Cross-case dependency** — Reject before run creation instead of allowing omission to turn an AND
  dependency into an accidental OR.
- **Missing, duplicate, mismatched, or bypassable join mapping** — Reject before run creation. Every
  case node must be upstream of its mapped terminal and every condition must converge once.
- **Oversized aggregate control projection** — Reject during compilation or event parsing before a
  valid workflow can exceed the durable run-event envelope.
- **Condition source output is truncated** — Append a typed side-effect-free control failure, select
  no case, start no branch, and fail the run.
- **Forged condition case or source digest in the ledger** — Reducer rejects replay at the exact
  event.
- **Forged omission without a false guard or omitted dependency** — Reducer rejects replay.
- **Forged join before branch settlement or with wrong terminals** — Reducer rejects replay.
- **Crash before control event append** — The pending pure transition is recomputed from committed
  evidence under exclusive run ownership.
- **Crash after control event append** — Replay consumes the recorded transition and never invokes
  an executor for it.
- **Selected branch fails** — Existing fail-fast node and run failure semantics apply; the join does
  not run.
- **Outer branch omits a nested condition** — Its guarded descendants and nested join become
  omitted; no inner case is selected.
- **Legacy workflow/run** — Optional control projection is absent, new control events are illegal,
  and all existing behavior remains unchanged.

## User, operator, and system flows

### User: select and converge

1. A classifier command succeeds with complete bounded output.
2. The condition commits one exact case decision tied to the classifier attempt and output hash.
3. Branch roots for other cases become durably omitted without approval, provider, sandbox, or
   executor calls.
4. The selected branch executes through ordinary Flow policy and evidence paths.
5. The explicit join waits for the selected terminal and all omitted alternatives, then commits its
   convergence evidence.
6. The unconditional downstream verifier runs and retains the existing acceptance authority.

### Operator: inspect a branch

Inspection exposes the selected case, source identity, each omitted node and reason, selected branch
evidence, and join mapping. The operator can distinguish pending work, unselected work, failed work,
and successful convergence without reading model prose or mutable files.

### System: restart at every boundary

- Before the condition event, replay sees a ready pure transition and produces the same exact case
  from the committed source.
- After the condition but before branch omission, replay restores the selected case and resumes the
  next declaration-order omission.
- During a selected executable attempt, existing Gate 4 recovery rules apply unchanged.
- After branch completion but before join, replay validates every succeeded/omitted terminal and
  commits the same join.
- After join, downstream readiness is ordinary dependency scheduling.

## Dependency and coupling analysis

```text
workflow YAML -> strict compiler -> immutable control graph
                                      |
                                      v
run_started control projection -> pure reducer <-> append-only event ledger
                                      ^                 |
                                      |                 v
                         application scheduler -> command/Pi executors
```

- The compiler owns static topology, case membership, and convergence proof.
- The run domain owns event legality and immutable projection from already-persisted facts.
- The application owns declaration-order transition selection and event publication.
- Executors receive only command or agent nodes. They cannot evaluate conditions, omit nodes, join
  branches, or select successors.
- CLI, supervisor, and run store continue to transport and display ordinary run state; they do not
  acquire graph authority.
- Pi remains the inner model/tool loop. OMP and Prime patterns remain research inputs rather than
  runtime dependencies.

## Approaches considered

| Approach | Simplicity | Expressiveness | Replay proof | Dependency safety | Extension path | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Optional `when` predicate independently evaluated on every node | High | Moderate | Can be deterministic if bounded | Scattered guards make branch propagation and convergence implicit | Poor for loops and packages | Rejected as too easy to bypass or misread |
| Explicit Choice node with nested branch subgraphs | Moderate | High | Strong | Strong lexical boundaries | Strong, but requires scoped ids, nested persistence, and subgraph migration now | Deferred until child-run/subgraph work |
| General string dependency expressions like Argo enhanced depends | Moderate | Very high | Parser can be deterministic | Powerful but failure/skipped truth tables become a user expression language | Strong for failure/fallback | Deferred until status-based recovery policies exist |
| User routing callbacks like LangGraph conditional edges | High for library users | Very high | Weak unless callback code and every input are versioned and sandboxed | Callback can bypass declarative review | High flexibility, high authority | Rejected for the core harness |
| Explicit condition + strict branch guards + explicit convergence join, lowered to a persisted control graph | Moderate | Deliberately bounded | Strong; all inputs and decisions are durable | Strong; omission propagates except at validated join | Clean base for parallel forks and bounded loops | **Selected** |

The selected design trades general expression power for inspectability and replay proof. Exact
string equality is intentionally small. Later typed results can add boolean, number, enum, or schema
paths without changing the condition/join state machine.

## Decision

Add immutable `condition` and `join` control nodes, strict case guards on executable and nested
condition branch roots, a bounded persisted control projection, and dedicated atomic condition,
omission, join, and control-failure events. Compile every case into one structurally validated branch
that converges exactly once. Treat omitted dependencies as blockers everywhere except the matching
explicit join.

Evaluate only complete already-committed command stdout/stderr or agent text using exact string
equality. Record the source attempt and full-stream hash with the selected case. Keep control nodes
outside `NodeExecutor`, Pi, command containment, approvals, effects, and external resource
accounting.

Do not claim parallel fork execution or Gate 5 completion in this slice. The next fork slice may
schedule multiple ready executable nodes under an explicit per-run concurrency budget while reusing
the same guards, omissions, and join evidence.

## State and invariant validation

For condition `C` with cases `K(C)`, selected case `s`, branch node set `B(C,k)`, mapped terminal
`T(C,k)`, and join `J(C)`:

- `s ∈ K(C)` and exactly one `node_condition_evaluated(C,s)` exists;
- every `B(C,s)` node is either succeeded/failed/running/pending according to ordinary execution;
- every `B(C,k != s)` node becomes omitted and has zero executor starts;
- `T(C,s)` must succeed before `J(C)` can succeed;
- every `T(C,k != s)` must be omitted before `J(C)` can succeed;
- every node in `B(C,k)` is an ancestor of `T(C,k)`;
- no ordinary node belongs to two cases of the same condition;
- only `J(C)` may depend across the case partitions of `C`;
- a succeeded join records exactly one completed terminal and `|K(C)| - 1` omitted terminals;
- declaration-order scheduling plus immutable state yields one next transition for every
  nonterminal safe boundary;
- control transitions add zero starts, tokens, reported cost, active execution time, policy
  decisions, or effects.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Valid condition, selected branch, convergence | Behavioral | `npx vitest run test/unit/application/run-workflow-control.test.ts -t "selected exact-match branch"` | Selected branch executes, alternative never executes, join and downstream verifier succeed | Concurrent branch execution |
| Durable source and selected case | Contract/data | `npx vitest run test/unit/run/control-flow-reducer.test.ts -t "reconstructs condition"` | Replay retains source node/attempt/field/hash and exact selected case | Semantic truth of model text |
| Omission prevents executor/approval/provider/sandbox calls | Behavioral/adversarial | `npx vitest run test/unit/application/run-workflow-control.test.ts -t "default branch"` | Omitted nodes have no starts or executor calls and inspectable reasons | Host isolation beyond existing adapters |
| Ordinary dependencies cannot bypass omission | Contract/behavioral | `npx vitest run test/unit/application/run-workflow-control.test.ts -t "default branch|nested condition"` | An ordinary descendant with any omitted dependency is omitted despite other successes | Status-based fallback expressions |
| Join waits for all mapped terminals | Contract/behavioral | `npx vitest run test/unit/run/control-flow-reducer.test.ts test/unit/application/run-workflow-control.test.ts -t "join"` | Premature/forged joins reject; valid join records selected and omitted terminals | Distributed joins |
| Deterministic restart and replay | Recovery | `npx vitest run test/unit/application/run-workflow-control.test.ts -t "recovers"` | Crashes around condition/omission/join/failure resume to the same next event and execute selected work once | Opaque model-session continuation |
| Invalid sources, fields, cases, guards, cycles, and joins | Contract/error | `npx vitest run test/unit/workflow/control-flow-compiler.test.ts` | Every invalid topology produces a stable path-specific diagnostic before run creation | A general expression language |
| Truncated evidence fails closed | Error/adversarial | `npx vitest run test/unit/application/run-workflow-control.test.ts -t "truncated"` | Typed control failure, no selected case, no branch executor call | Recovery of discarded output bytes |
| Legacy representation and behavior unchanged | Regression | `npx vitest run test/unit/workflow/compiler.test.ts test/unit/application/run-workflow.test.ts` | Existing compiled snapshots, order, and recovery tests remain green | Schema stability after v1alpha1 |
| Public docs and executable example | Docs/runtime/release | `npx vitest run test/scaffold/community-files.test.ts && npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | README, architecture, workflow spec, roadmap, testing guide, example, full suite, runtime, package, coverage, and audit agree | Remaining Gate 5 features |

## Planned RED → GREEN → REFACTOR sequence

1. **Compiler RED** — Add valid snapshot and invalid source/case/guard/cross-branch/join topology
   tests; prove the current schema rejects control nodes.
2. **Compiler GREEN/REFACTOR** — Add immutable source/compiled contracts and one centralized branch
   membership/convergence validator while preserving legacy compiled values.
3. **Reducer RED** — Add event-schema, state-projection, forged condition, forged omission, premature
   join, and legacy-illegality tests.
4. **Reducer GREEN/REFACTOR** — Persist the bounded control projection and implement atomic pure
   transitions with strict replay checks.
5. **Scheduler RED** — Add exact/default routing, omission propagation, branch failure, join,
   approval non-entry, resource neutrality, and crash-boundary resume tests.
6. **Scheduler GREEN/REFACTOR** — Replace succeeded-only readiness with one deterministic typed
   transition selector; keep command/agent execution paths unchanged.
7. **Composition/docs RED/GREEN** — Add an executable conditional example and public-contract tests,
   then update every capability and limitation surface.
8. **VERIFY** — Run focused suites after each layer, full release gates, CLI runtime samples,
   mutation/adversarial ledger probes, exhaustive diff review, and external-contract cross-check.

## Primary research and independent checks

- Amazon States Language specification: https://states-language.net/spec.html
- Temporal deterministic Workflow Definition constraints:
  https://docs.temporal.io/workflow-definition
- Temporal Child Workflow isolation and event-history guidance:
  https://docs.temporal.io/child-workflows
- Argo DAG behavior: https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/
- Argo enhanced dependency result states:
  https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/
- LangGraph graph/conditional-edge documentation:
  https://langchain-ai.github.io/langgraph/how-tos/state-reducers/
- OMP task-agent behavior:
  https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md
- Prime Agent repository and daemon design:
  https://github.com/PrimeIntellect-ai/prime-agent
- Installed Pi 0.84.0 `agent-loop.js.map`, session manager, and exact Flow adapter integration were
  inspected locally; Pi's inner turn loop and session tree do not own Flow graph transitions.

## Consequences and remaining uncertainty

- Branch decisions become inspectable, replayable, and provider-neutral without adding a code
  execution surface to the workflow language.
- The run-start event grows only for workflows using control flow. Its actual serialized control
  projection is capped at 512 KiB within the existing 2 MiB event ceiling.
- Omission becomes a permanent domain concept needed by conditions, later loops, packages, and
  failure/fallback routing. Its semantics therefore receive reducer-level rather than UI-only
  treatment.
- Exact text comparison is intentionally austere. It is adequate for deterministic classifiers and
  explicit model routing, but typed JSON results will be preferable before child runs and
  optimization metrics.
- Requiring every case to contain work is temporarily verbose. A future pure pass node can add
  empty-branch ergonomics without weakening the current topology proof.
- This slice proves logical fork selection and join convergence, not simultaneous execution.
  Concurrency needs bounded slots, deterministic event publication, cancellation propagation, and
  failure quiescence before the roadmap can mark fork/join complete.

## Adversarial review dispositions

| Priority | Finding | Disposition |
| --- | --- | --- |
| P1 | An outer branch could omit a nested condition, leaving descendants waiting forever for a decision the omitted condition could never produce | Fixed: scheduler and reducer now propagate dependency omission through nested conditions and their joins; a full nested workflow regression reaches the outer join and final verifier |
| P1 | The persisted control graph checked shape but did not independently repeat compiler branch-membership, cross-case, terminal, and join-completeness invariants | Fixed: run-start replay now rejects wrong-case terminals, cross-case dependencies, bypassable joins, missing guarded cases, and non-command terminals before accepting later events |
| P1 | Per-condition comparison bounds allowed an aggregate control projection that could exceed the durable event envelope after valid compilation | Fixed: compiler and event parser enforce a shared 512 KiB actual serialized JSON UTF-8 ceiling; oversized boundary tests cover both paths |
| P2 | The initial decision-journal YAML indentation and several verification filters were not directly executable | Fixed: corrected the example and mapped commands to actual test names/files |

No adversarial finding remains open in this slice.

## Final verification evidence

- `npm run check` — passed formatting, lint, strict TypeScript, 686 default tests in 53 files,
  production build, and 20 compiled runtime tests in 3 files.
- `npm run test:coverage` — passed configured thresholds with 83.68% statements, 76.27% branches,
  92.28% functions, and 83.87% lines.
- `npm run pack:check` — passed clean archive installation, CLI execution, project initialization,
  and configuration inspection in a temporary consumer.
- `npm audit --omit=dev --audit-level=low` — reported zero production vulnerabilities.
- `node dist/cli/main.js validate examples/conditional-branch.workflow.yaml` — accepted the
  credential-free six-node public example.
- `npx vitest run test/scaffold/community-files.test.ts test/unit/application/run-workflow-control.test.ts test/unit/run/control-flow-reducer.test.ts test/unit/workflow/control-flow-compiler.test.ts` — 67 focused tests passed.
- `git diff --check` — passed.
- `actionlint .github/workflows/ci.yml` — passed.

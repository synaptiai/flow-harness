# Decision Journal: Issue #175 — Evaluate bounded one-shot delegation

**Issue**: #175 | **Branch**: `codex/issue-175-bounded-delegation` | **Started**: 2026-08-24

---

## Context

Flow already owns two related boundaries. Static `child` nodes execute reviewed embedded workflows
through deterministic child-run identities, reflink workspaces, five-dimensional budget ceilings,
typed results, durable run events, cancellation, recovery, replay validation, and confirmed
cleanup. Evaluation plans already compare two immutable profiles under paired task, seed, model,
network, retry, and budget controls.

Slice 10.4 combines those boundaries for one experiment only. A model-backed manager can decide
whether to invoke one already-reviewed local specialist. The manager cannot author the objective,
select another specialist, expand authority, change a result schema, start background work, or
delegate again.

The user approved Refined Approach B: one sealed no-argument tool on one exact manager node, one
foreground child, typed return data, existing child-run evidence, complete cancellation and replay
behavior, paired evaluation, and no activation or remote task surface.

## Existing evidence

- `CompiledRunBudget` and run replay account for `nodeStarts`, `modelTokens`,
  `modelCostUsdMicros`, `executionMs`, and `artifactBytes`. Static child admission requires every
  child ceiling and reserves the complete ceiling before concurrent child execution.

- Static child runs derive their identity from the parent run, parent node, and attempt. They use a
  recoverable run store, a `reflink-copy-v1` workspace, a persisted parent link, an exact compiled
  workflow and result schema, and `ChildEvidence`. Child resources are added once when the parent
  accepts that evidence.

- `CapabilitySnapshot` is persisted in `run_started`, digest-bound, replay-validated, bounded to
  16 MiB, and available to the application and Pi executor. It is the correct immutable carrier for
  an evaluation-only capability that must not change the workflow schema.

- The embedded Pi runner already accepts Flow-owned custom tools, serializes their exact provider
  surface into model-session identity, executes sequential tools with one abort signal, and waits
  for attempt-scoped recorders before it reports cleanup settlement.

- Generic evaluation comparison already uses the exact verdicts `superior`, `not_superior`,
  `insufficient_evidence`, and `constraint_failed`. Slice 10.4 must reuse those verdicts instead of
  creating favorable synonyms.

- Prompt-only Agent Client Protocol (ACP) executors expose no Flow tool surface. Native Pi, Open
  Multi-Provider (OMP), and Prime adapters are separate harness profiles. None can receive the
  delegation capability.

## Approved architecture

### Refined Approach B: sealed foreground delegation experiment

One `DelegationEvaluationCandidate` binds an exact baseline workflow, exact capability-package
closure, one manager agent, one literal child objective, one complete child workflow, one typed
result, one five-dimensional child budget, maximum depth `1`, maximum calls `1`, and one exact
embedded Pi executor identity. Admission compiles both workflows, revalidates all referenced
regular files without following links, rejects drift, rejects nested child workflows, and verifies
that the manager is a local embedded-Pi agent.

The evaluation baseline and candidate use identical root workflow bytes and digests. The baseline
uses the exact package snapshot without delegation. The candidate uses the same package snapshot
plus one immutable delegation snapshot. No workflow node, prompt, model route, tool declaration,
or control edge changes between the pair.

Only the exact manager receives `flow_delegate`. The tool has an empty object schema and therefore
accepts no model-authored objective, identity, authority, or scheduling input. The manager can skip
the tool or call it once. A second call fails deterministically. The child snapshot never propagates
into the child run, so the child cannot delegate recursively.

Before the manager attempt starts, Flow checks that the parent has headroom for the complete child
ceiling and reserves that ceiling for scheduling. A tool call writes a durable delegation intent
before workspace or child-run creation. It then runs one blocking child through the existing child
store and workspace lifecycle. The tool returns the exact canonical child result only after the
child is terminal and its workspace is discarded. Child resources are charged once from the
durable delegation settlement; manager resources remain the manager node's ordinary evidence.

The manager's signal, timeout signal, and command-safety signal converge on the tool and child.
The manager cannot settle until the tool, child run, process tree, and workspace cleanup are
quiescent. An unresolved prepared delegation is an uncertain prior effect. Recovery reopens or
cleans up the exact derived child identity, records the reconciliation result, and blocks an
automatic manager retry instead of silently executing a second manager attempt.

Evaluation purpose `delegation-v1` requires at least one declared delegation-suitable holdout task
and one sequential-control holdout task. The pair uses identical fixtures, instructions,
verification, root workflow, model controls, packages, seeds, order, network denial, and retry
denial. Trial evidence preserves candidate, manager, child, executor, invocation, result, resource,
lifecycle, cancellation, and cleanup identities. Aggregation reports outcomes and resource changes
by task class, requires complete evidence, and never grants activation.

### Exact executor identity

The executor identity binds the current Node version and executable bytes, the embedded Flow Pi
adapter contract, the installed `@earendil-works/pi-coding-agent` closure, the installed
`@earendil-works/pi-ai` closure, and their package versions and integrity declarations. Admission
observes the installed files and revalidates them before each candidate trial. It reuses the native
Pi registry's bounded, no-follow package-closure and executable hashing primitives; it doesn't
trust version strings alone.

### Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Compile delegation into a static child node | Reuses the full existing child path | The model no longer decides whether decomposition is useful, so it doesn't test dynamic delegation | Rejected |
| Sealed one-shot tool backed by the child lifecycle | Tests the intended decision while keeping every parameter reviewed and bounded | Adds a durable in-attempt lifecycle and evaluation evidence | Approved |
| General manager-created child requests | Flexible objectives and specialist selection | Makes model output scheduling authority and expands review, policy, replay, and budget risk | Rejected |
| Remote A2A or MCP task execution | Standard remote task lifecycle concepts | Remote identity, authenticated authority propagation, multi-host settlement, and tenant isolation are not defined | Deferred |
| Background child handles | Useful concurrency | Requires ownership, follow-up, orphan cleanup, and durable handle semantics not needed by this experiment | Deferred |

## User, operator, and system flows

### Validate the candidate

1. The operator writes one candidate beside the exact root and child workflow sources.
2. Flow reopens the candidate and both workflow sources without following links and enforces byte
   limits.
3. Flow compiles the root and child, verifies their source and compiled digests, binds the exact
   empty or non-empty package closure, validates the manager and result targets, and rejects nested
   delegation structure.
4. Flow resolves and observes the current embedded Pi executor closure and requires it to match the
   declared identity.
5. Flow revalidates every observed source and executor artifact before returning one immutable
   candidate identity and baseline/candidate snapshots.

### Run a paired experiment

1. The operator selects purpose `delegation-v1`, the same root workflow for both profiles, one
   candidate only on the candidate profile, exact shared controls, and both task classes.
2. Flow admits the pair and proves that the root workflow, package closure, controls, tasks, and
   schedule are identical except for the delegation snapshot.
3. A baseline trial runs through the ordinary Flow path with no delegation tool.
4. A candidate trial exposes the sealed tool only to the exact manager. The manager either skips it
   or invokes it once.
5. If invoked, Flow records intent, runs and settles the exact child, validates its typed result,
   discards its workspace, returns the result, and records complete resource and lifecycle evidence.
6. Flow stores task-class-aware observations and computes the ordinary constrained verdict. It
   doesn't create or propose an activation.

### Cancel or recover

1. Cancellation reaches the manager session, active tool call, child workflow, child commands, and
   workspace cleanup through one combined signal.
2. Flow waits for the child boundary to quiesce before it settles the manager outcome.
3. If a process stops after intent but before durable settlement, recovery derives the same child
   identity and reconciles that exact child and workspace.
4. Flow records the reconciliation and returns an `uncertain_operation` recovery error. It doesn't
   rerun the manager automatically.

## Coupling analysis

- The adaptation domain owns candidate schema, limits, exact identities, workflow/result binding,
  and the immutable delegation snapshot. It has no filesystem, Pi session, or evaluation-store
  dependency.

- Filesystem admission owns no-follow reads, bounded source capture, package closure resolution,
  executor observation, race detection, and final revalidation. It doesn't execute a child.

- The capability snapshot owns the evaluation-only delegation identity persisted with a run. It
  doesn't add `delegate` to ordinary workflow tool selectors or package policy actions.

- The application runtime owns parent-budget preflight, write-ahead delegation events,
  deterministic child identity, foreground child execution, recovery, resource settlement, and
  replay-safe evidence. It delegates workspace and node execution to existing ports.

- Pi infrastructure owns conditional presentation of the sealed tool and waits for its execution.
  It can't change the candidate objective, child workflow, result schema, or call ceiling.

- Evaluation owns pairing, task-class coverage, complete observations, aggregate interpretation,
  content-free inspection, and the no-activation boundary. It doesn't infer delegation success from
  task success alone.

- The CLI composes admitted evaluation candidates and exact executor observation. It doesn't expose
  a standalone production delegation switch, remote endpoint, background handle, or activation
  command.

## Specification

_Captured by specification-capture skill on 2026-08-24. Source: user-confirmed._

### Non-goals

- No ordinary workflow schema or built-in `AgentToolName` gains a delegation selector.

- No favorable evaluation verdict activates delegation or changes an effective harness state.

- No manager can supply or modify a child objective, workflow, model route, package closure,
  budget, result schema, depth, or call ceiling.

- No recursive, parallel, detached, durable background, remote, A2A, MCP task, or multi-host
  delegation is enabled.

- No prompt-only ACP agent or external harness adapter can receive `flow_delegate`.

- No child workspace output is promoted into the manager or evaluation fixture.

- No claim is made that delegation improves sequential, tightly coupled, or communication-heavy
  work.

### Failure modes

- **Timeouts** — A manager, tool, child, command, model, or cleanup timeout cancels the complete
  foreground boundary. Flow reports bounded non-success evidence and doesn't allow an uncertain
  child effect to become a retryable manager attempt.
- **Partial failures** — A prepared but unsettled child, a terminal child without a typed result, a
  typed result without confirmed cleanup, or a manager settlement without matching delegation
  evidence fails closed. Successful components cannot mask a missing component.
- **Invalid input** — Malformed, oversized, linked, stale, unsupported, identity-mismatched,
  recursive, over-budget, over-depth, or over-call input is rejected before it grants scheduling
  authority. The fixed error contains no private objective or result content.
- **Missing context** — A missing recoverable run store, workspace isolator, package closure,
  executor identity, model-session store, result schema, child budget, evaluation task class, or
  lifecycle record prevents the trial or produces `insufficient_evidence`.
- **No delegation call** — The manager can complete normally. Evidence records zero invocations and
  no child resource use.
- **Second or recursive call** — The tool returns a deterministic denial; no second child intent or
  workspace is created.
- **Child failure or resource exhaustion** — The tool returns a bounded failure and the manager
  attempt cannot present the child as a successful typed result.
- **Malformed child result** — The child settlement is non-success; no inferred or repaired value is
  returned to the manager.
- **Cancellation before intent** — No child identity is created.
- **Cancellation after intent** — Flow settles or reconciles the exact child and cleanup before the
  manager can settle.
- **Executor or source drift** — Candidate admission or trial revalidation fails; Flow doesn't
  substitute another executor, workflow, objective, or package.
- **Open delegation during recovery** — Flow reconciles the exact child and blocks automatic manager
  retry with `uncertain_operation`.
- **Missing or incomparable evaluation evidence** — The result is `insufficient_evidence`, never an
  inferred favorable verdict.
- **Constraint breach** — The result is `constraint_failed`; it never activates the candidate.

### Interface contracts

- A delegation candidate binds one exact root workflow source and digest, exact package-closure
  digest, exact manager target, literal objective identity, exact child workflow source and digest,
  exact result-node and schema identities, exact executor identity, all five positive budget
  ceilings, `maxDepth: 1`, and `maxCalls: 1`.

- A candidate capability snapshot contains the complete private reviewed child definition and
  content-free identities. Its digest changes for any objective, workflow, package, executor,
  budget, target, schema, depth, or call change.

- `flow_delegate` has an empty strict input schema, sequential execution mode, and exactly one
  invocation slot. Its successful output is the child result's canonical JSON value under the
  admitted result schema.

- A delegation intent is durable before child workspace creation. A settlement references the same
  manager attempt, delegation sequence, child-run identity, workflow identity, result schema,
  terminal sequence, resources, workspace disposition, and result identity.

- Child delegation evidence is resource authority exactly once. Agent evidence can reference the
  durable receipt but cannot duplicate the child's five resource values into manager usage.

- The candidate snapshot isn't propagated into the child capability snapshot. The child receives
  only the exact ordinary package closure required by its compiled workflow.

- Purpose `delegation-v1` requires one exact baseline/candidate pair, identical root workflow and
  package controls, a single delegation candidate on the candidate profile, holdout-only
  filesystem verification, at least one `delegation-fit` task and one `sequential-control` task,
  paired alternating order, network denial, and zero provider and harness retries.

- Delegation evaluation uses existing comparison verdicts and has no activation artifact or
  transition contract.

- Public inspection and export expose hashes, byte counts, identities, states, metrics, and
  verdicts. They exclude objective text, prompts, model output, child result content, credentials,
  environment values, and workspace paths.

## Verification map

| Criteria | Type | Verification command | Passing evidence | Doesn't promise |
| --- | --- | --- | --- | --- |
| 1, 2 | Candidate and admission contract | `npx vitest run test/unit/adaptation/delegation-evaluation-candidate.test.ts test/unit/infrastructure/fs/local-delegation-evaluation-candidate.test.ts test/unit/infrastructure/fs/local-evaluation-plan-delegation.test.ts` | Boundary values, exact identity, no-follow reads, drift rejection, executor revalidation, and exact baseline/candidate pairing pass | General executable plugin admission |
| 3, 4, 6 | Tool and runtime behavior | `npx vitest run test/unit/infrastructure/pi/workspace-agent-delegation-tool.test.ts test/unit/application/run-workflow-delegation.test.ts` | Zero or one call, fixed objective, typed result, isolation, one resource charge, second-call denial, and recursion denial pass | Parallel or background delegation |
| 5 | Cancellation, recovery, and replay | `npx vitest run test/unit/application/run-workflow-delegation-recovery.test.ts test/unit/run/delegation-events.test.ts` | Write-ahead intent, cancellation at each boundary, exact reconciliation, cleanup, replay rejection, and blocked automatic retry pass | Multi-host recovery |
| 7–9 | Evaluation and public evidence | `npx vitest run test/unit/evaluation/delegation-evaluation.test.ts test/integration/cli/delegation-evaluation.test.ts` | Task-class coverage, decomposed observations, existing verdicts, content-free inspect/export, and no activation pass | Benchmark superiority before measured held-out evidence |
| 10 | Documentation | `npm run docs:capabilities:generate && npm run docs:capabilities:check && npm run docs:style && npm run docs:links && npm run docs:ste` | Canonical guide, documentation hub, concise README, architecture Mermaid, repository map, roadmap, status, and generated reference are current | Third-party certification |
| 11 | Full quality and runtime | `npm run ci:local && npm run check && npm audit --audit-level=high` | Formatting, lint, type checks, unit/integration/runtime tests, build, packaging, public capability checks, docs, and high-severity audit pass | Remote A2A or paid-provider behavior |

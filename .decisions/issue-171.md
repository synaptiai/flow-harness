# Decision Journal: Issue #171 — Evaluate and activate phase-aware model routing

**Issue**: #171 | **Branch**: `codex/issue-171-phase-routing` | **Started**: 2026-08-23

---

## Context

Flow can review, evaluate, activate, and roll back one exact model replacement for one root agent.
Slice 10.2 adds a deterministic phase profile across planning, execution, verification, and explicit
escalation. The model must not select a route, create a phase, or obtain fallback authority.

The user approved Refined Approach B for “Slice 10.1b.” The repository and remote state show that
Slices 10.1a, 10.1b, and 10.1c are already merged, while Refined Approach B is the pending Slice
10.2 proposal. This implementation applies the approval to Slice 10.2 and records that interpretation
explicitly.

## Existing evidence

- `ModelRoutingCandidate` replaces one model tuple on one root agent and proves that no other
  compiled workflow field changed.

- `EffectiveHarnessState` stores complete immutable workflow bytes and the non-policy capability
  closure. Activation and rollback already select complete states rather than mutable overlays.

- `EvaluationPlan` supports paired alternating schedules and exact per-profile routes for one root
  agent. Its generic comparison reports `superior` only when the success-rate confidence interval
  exceeds a positive effect threshold.

- `ModelSession` stores hash-chained request identities, provider usage, and request settlement
  timestamps. It does not yet bind an operator selection rule, phase target, or fallback decision.

- Child workflows are compiled recursively. A child can embed workflow source or resolve an exact
  workflow package. Rewriting a packaged child would require publishing a new package closure, so
  the first phase-routing profile can target root nodes and nested embedded workflows only.

## Approved architecture

### Refined Approach B: Immutable phase-routing profile

The operator supplies one inert candidate with exact baseline and candidate phase profiles. Each
profile has a closed assignment for every model-bearing target that it controls. An assignment binds
one role, one deterministic exact-target rule, one model tuple, and one address containing the root
workflow, nested child path, target workflow, and node identifier.

Flow projects baseline and candidate workflows independently. The selected baseline state remains
unchanged. The candidate projection rewrites only declared model tuples and stores the admitted
candidate profile in the candidate effective state. The profile is not workflow-authored runtime
authority and cannot be changed by a model.

Every embedded-Pi provider request records the selected profile and assignment identity before
provider I/O. The request event identifies the provider, model, reasoning setting, phase, target,
selection rule, route result, fallback decision, and escalation decision. Existing usage events and
request timestamps retain per-call cost and latency evidence. A missing, ambiguous, or stale
assignment fails before provider I/O. The first production profile does not route through ACP
agents because Flow cannot observe or enforce their internal provider calls.

Paired evaluation uses a dedicated `phase-routing-v1` purpose. It requires the exact baseline and
candidate profile projections and reports quality non-inferiority separately from cost and latency
efficiency. Activation requires a complete qualified report; the generic strict-superiority verdict
does not authorize this surface.

### Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Extend one-node route replacement | Smallest schema change and reuses existing activation | Cannot express roles, nested paths, multi-route identity, or non-inferiority | Rejected |
| Immutable phase-routing profile | Closed authority, exact replay, nested addressing, and purpose-specific qualification | Adds a new candidate surface and durable profile evidence | Approved |
| Runtime classifier or learned router | Can adapt per request from task content or provider state | Transfers routing authority, adds classifier drift and fallback ambiguity | Evaluation-only; not production authority |
| Provider gateway routing | Centralizes provider selection and availability handling | Adds a remote trust dependency and weakens local replay identity | Deferred |

## User, operator, and system flows

### Review and compose a candidate

1. The operator selects the current effective harness head and one inert phase-routing candidate.
2. Flow reopens the candidate and baseline without following links and verifies their byte identities.
3. Flow resolves every exact target through its child path and rejects duplicates, omissions,
   package-backed rewrite targets, and route drift.
4. Flow independently projects the declared baseline and candidate profiles.
5. Flow proves that only declared model tuples differ and stages one immutable effective candidate.

### Run paired qualification

1. The operator selects the staged baseline and candidate states in one held-out paired plan.
2. Flow binds both exact phase profiles, workflows, tasks, fixtures, seeds, budgets, retry policy,
   network policy, verification, and environment controls.
3. Each trial runs in a fresh workspace and records route evidence before each provider call.
4. Flow compares verified success non-inferiority, false completions, policy violations, cost, and
   latency only across complete same-environment pairs.
5. Missing quality, cost, latency, route, safety, or verifier evidence produces
   `insufficient_evidence`; a constraint breach produces `not_qualified`.

### Activate, run, recover, and roll back

1. Flow previews or applies only a complete `qualified` phase-routing evaluation.
2. Activation publishes the immutable candidate state and advances the existing single harness head.
3. Attached, detached, child, and recovered runs use the profile stored in the selected state.
4. Every routed request must match one stored assignment. Flow has no silent provider fallback.
5. Rollback selects a retained complete state, including its prior phase profile or lack of one.

## Coupling analysis

- The domain layer owns candidate parsing, nested target resolution, profile identity, projection,
  request-route evidence, and qualification semantics. It has no provider or filesystem dependency.

- The application layer supplies the selected assignment to the existing executor boundary and
  prepares purpose-specific activation decisions.

- Filesystem infrastructure reopens bounded candidate and evaluation sources, preserves no-follow
  guarantees, and stores immutable profile-bearing states.

- The Pi adapter records the admitted decision before provider I/O. It does not select a route.

- The evaluator schedules paired trials and aggregates independently admitted evidence. It does not
  infer missing cost, latency, safety, or route observations.

- The CLI composes these boundaries and emits content-free identities. It does not parse profiles or
  authorize activation by itself.

## Specification

### Non-goals

- No learned router, model-authored route, task classifier, provider discovery, load balancing, or
  silent fallback becomes production authority.

- No workflow YAML field can select a phase profile or candidate.

- No provider pricing catalog, availability oracle, credential broker, or remote routing service is
  introduced.

- The first profile does not rewrite packaged child workflow source or claim support for opaque ACP
  internal provider calls.

- Qualification does not claim that different models have equal capabilities outside the admitted
  held-out tasks, controls, and environments.

### Failure modes

- **Invalid or stale source** — Admission fails without publishing candidate authority.
- **Missing or ambiguous target** — Composition fails before staging a candidate.
- **Missing runtime assignment** — Execution fails before provider I/O and does not fall back.
- **Provider failure** — The selected call fails under existing retry limits; no alternative route is
  selected.
- **Incomplete accounting** — Missing cost or latency evidence makes qualification insufficient.
- **Partial evaluation** — Missing trials or environment-mismatched pairs make qualification
  insufficient.
- **Commit uncertainty** — Existing effective-state settlement reopens exact durable state to decide
  whether activation committed.
- **Recovery drift** — A changed workflow, profile, capability snapshot, or request identity fails
  closed.

### Interface contracts

- A phase profile contains only the four closed roles `planner`, `executor`, `verifier`, and
  `escalation`, exact assignments, `exact-target-v1` selection, and `deny` fallback.

- A target address binds the root workflow, ordered child node path, target workflow, and model-bearing
  node. Target addresses are unique within a profile.

- Baseline and candidate profiles cover the same ordered target set and preserve each target role.
  At least one route must change.

- Route evidence identifies the selected profile and assignment and must match the provider request
  tuple. The event contains no credential or private prompt content.

- A `phase-routing-v1` qualification has independent quality, cost, and latency gates. Only its
  `qualified` verdict can activate this surface.

## Verification map

| Criteria | Type | Verification command | Passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–2 | Contract and behavioral | `npx vitest run test/unit/adaptation/phase-routing-candidate.test.ts test/unit/application/prepare-effective-harness-candidate.test.ts` | Closed roles, nested embedded targets, dual projection, and immutable-field mutation tests pass | Dynamic or package-backed child routing |
| 3–4 | Behavioral and error | `npx vitest run test/unit/run/model-session.test.ts test/unit/application/run-workflow-phase-routing.test.ts test/unit/pi/pi-agent-executor.test.ts` | Every request binds exact route evidence; missing, ambiguous, stale, ACP, and fallback paths fail before provider I/O | Provider invoice reconciliation |
| 5 | Data and behavioral | `npx vitest run test/unit/evaluation/phase-routing-evaluation.test.ts test/unit/evaluation/aggregate.test.ts` | Non-inferiority and efficiency matrices return qualified, not-qualified, or insufficient verdicts correctly | Global model superiority |
| 2, 5–6 | Integration | `npx vitest run test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts test/unit/application/prepare-effective-harness-activation.test.ts test/integration/cli/evaluation.test.ts test/integration/cli/effective-harness-runtime.test.ts` | Exact profile identity survives evaluation, activation, runtime, recovery, inspection, and rollback | Paid-provider availability |
| 6 | Runtime and recovery | `npx vitest run test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/application/run-workflow-capabilities.test.ts` | Attached, detached, child, replay, and recovery preserve the selected profile | Multi-host distributed recovery |
| 7 | Documentation | `npm run docs:capabilities:generate && npm run docs:capabilities:check && npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/architecture-documentation.test.ts` | Generated reference, canonical guide, roadmap, status, Mermaid diagram, and repository map are current | External certification |
| 8 | Static and runtime | `npm run ci:local` | The local CI-equivalent pipeline, runtime checks, and package checks pass | Live paid-provider behavior |

## Implementation sequence

1. RED/GREEN the closed phase profile, nested address resolver, baseline and candidate projections,
   identity digest, and mutation matrix.
2. RED/GREEN effective candidate/state/runtime unions and immutable activation transport.
3. RED/GREEN per-request route decision resolution, durable model-session evidence, no-fallback
   behavior, child-path propagation, and ACP refusal.
4. RED/GREEN `phase-routing-v1` plan admission, durable headers, reports, and qualification matrix.
5. RED/GREEN purpose-specific activation and all attached, detached, child, recovery, inspection, and
   rollback paths.
6. Update the capability reference, canonical operator guide, documentation hub, roadmap, project
   status, testing guide, and architecture diagram and repository map.
7. Run focused, serial, coverage, runtime, package, documentation, adversarial, and local CI gates.


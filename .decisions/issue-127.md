# Decision Journal: Issue #127 — Reviewable model-routing candidates

**Issue**: #127 | **Branch**: `codex/issue-127-model-routing-candidates` | **Started**:
2026-08-19

---

## Context

Flow can generate, evaluate, activate, compose, and roll back prompt and Agent Skill candidates.
Each selected activation is one complete effective harness state with exact workflow bytes and the
immutable non-policy package closure required for execution.

The paired evaluator currently requires every model-bearing node in both profiles to match one
shared provider, model id, and thinking level. That rule is correct when the experimental variable
is a prompt or an inert capability package. It cannot describe a routing experiment because the
route is the variable under test.

Issue #127 adds one bounded static route candidate. An operator reviews one exact model tuple for
one existing root workflow agent node. Flow compares both routes under equal non-route controls.
The existing effective-state protocol governs preview, apply, offline execution, recovery, and
rollback.

## Current evidence

- `EffectiveHarnessState` already binds exact workflow bytes, compiled workflow identity, and the
  complete immutable non-policy package closure.

- `EffectiveHarnessCandidateArtifact` currently permits prompt, Agent Skill resource, and Agent
  Skill package surfaces. Its parser proves that only the declared surface differs.

- `EvaluationPlan` version 1 currently has one shared model tuple. Evaluation admission recursively
  requires every agent and model verifier in both workflows to use that tuple.

- The workflow model tuple contains provider, model id, and thinking level. Provider credentials
  are runtime configuration and are not part of workflow or candidate identity.

- Existing runtime and rollback paths use immutable selected state. They do not consult live
  candidate files.

## User, operator, and system flows

### Review and compose a route candidate

1. The operator selects the current effective harness head as the baseline.

2. The operator supplies one candidate with an existing root agent target and exact replacement
   tuple.

3. Flow reopens and verifies the candidate source without following links.

4. Flow proves that the declared before tuple matches the exact active state.

5. Flow projects only the declared model tuple and stages one immutable effective candidate.

6. Public output shows state, target, route, and digest identities.

### Paired route evaluation

1. The operator selects the staged baseline and candidate states in one paired plan.

2. Flow binds the exact route for each profile in the admitted plan identity.

3. Flow proves that tasks, fixtures, seeds, order, budgets, network policy, retries, and verification
   match. Every non-route workflow field must also match.

4. Each trial uses its profile's exact route and a fresh workspace.

5. Durable trial and report evidence retains the profile route identity and measured cost, token,
   success, failure, and policy evidence.

6. Offline inspection and export use durable evidence without live source or provider configuration.

### Activate and roll back

1. The operator requests a content-free preview for a superior complete paired result.
2. Flow verifies the exact candidate artifact, evaluation, current head, and baseline/candidate
   route identities.
3. Apply rechecks the same identities under mutation ownership.
4. Flow publishes immutable dependencies, then advances the single effective harness head.
5. Attached, detached, child, recovery, and replay paths use the selected immutable state.
6. Rollback selects any retained complete state and does not reconstruct a route from live input.

### Cancellation and failure settlement

1. Pre-ownership cancellation returns the exact caller reason and publishes no authority.
2. Source drift, stale heads, mismatched route identities, or unsupported runtime policy fail
   closed with value-free errors.
3. A failure before the authoritative head change leaves the old state selected.
4. A failure after the commit boundary reopens exact durable state. The existing protocol returns
   settled or commit-uncertain.

## External standards evidence

- [Agent Spec](https://oracle.github.io/agent-spec/26.1.2/agentspec/language_spec_26_1_2.html)
  defines model configuration in portable agent descriptions. It does not define Flow's paired
  evaluation, activation authority, or rollback evidence.

- [Agent Spec manager-workers](https://oracle.github.io/agent-spec/26.1.2/api/agenticpatterns.html)
  describes model and agent orchestration patterns. This issue does not introduce dynamic workers
  or model-selected delegation.

- [ACP v2](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)
  standardizes client-to-agent sessions, updates, permissions, and cancellation. It does not define
  internal harness routing or evaluation authority.

- [A2A](https://a2a-protocol.org/dev/specification/) standardizes remote agent discovery, tasks,
  messages, and artifacts. It is not a model-provider router and does not replace this local state
  contract.

- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) expose
  application-selected context. They do not define model-route experiments, statistical evidence,
  activation, or rollback.

These standards inform vocabulary and future interoperability. Flow keeps its existing local
authority and evidence boundaries rather than treating a transport standard as a routing policy.

## Architecture alternatives

The roadmap comparison considered seven ordinal dimensions. They covered product value, seam fit,
authority safety, evaluation readiness, standards fit, simplicity, and future value. Scores were
design judgments from one to five. They were not runtime measurements.

| Approach | Value | Seam | Safety | Evaluation | Standards | Simplicity | Future value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A. Memory candidates | 4 | 2 | 4 | 5 | 3 | 2 | 5 |
| B. Declared child-agent specialization | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| C. Model-routing candidates | 4 | 5 | 3 | 1 | 3 | 2 | 4 |
| D. WASI executable extensions | 5 | 1 | 1 | 2 | 5 | 1 | 5 |

An exhaustive grid assigned 14 non-negative integer weight units across the seven dimensions. It
evaluated 38,760 combinations. Approach B won 22,187 combinations, memory won 8,470, routing won
2,041, executable extensions won 3,061, and 3,001 tied. A pessimistic child-agent semantics grid
made memory the plurality winner. The result showed that no approach dominated independently of
product intent. The user selected Approach C because routing is the desired next roadmap surface.

### Routing semantics alternatives

| Alternative | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Static reviewed tuple | Smallest explicit authority. Exact paired evidence. Composes with current state. | One route per candidate. The operator supplies the alternative. | Selected |
| Evidence-generated tuple | Can recommend a route from tuning evidence | Requires a trusted model catalog, pricing/currentness, and generation grammar before comparison | Deferred |
| Runtime task classifier | Can choose models per task | Adds dynamic routing authority, classifier evaluation, fallback semantics, and replay complexity | Rejected for this issue |
| Provider gateway router | Centralizes credentials and availability | Adds a remote trust dependency and does not itself provide Flow evaluation or activation evidence | Deferred |

## Coupling analysis

The dependency direction remains CLI and infrastructure → application → domain.

- The domain owns the route candidate identity, exact tuple bounds, digest, and surface-only
  invariant. It has no provider client or filesystem dependency.

- The application layer projects a reviewed route onto an exact effective state and prepares
  evaluation or activation decisions.

- Filesystem infrastructure reopens bounded candidate and evaluation sources, stores immutable
  artifacts, and preserves atomic head transitions.

- The evaluator records profile-specific route controls but continues to own equal tasks, seeds,
  budget, network, retries, order, and deterministic verification.

- Provider adapters consume admitted trial controls. They do not discover candidate routes or make
  activation decisions.

- The CLI composes these boundaries and emits content-free public views. It does not become the
  parser or evidence authority.

No separate routing head, mutable routing catalog, provider gateway, or runtime classifier is
introduced. This avoids circular state authority and keeps one selected complete harness state.

## Specification

_Captured by specification-capture on 2026-08-19. Source: extracted from Issue #127 and the approved
Approach C decision._

### Non-goals

- This issue does not add dynamic routing, fallback, load balancing, provider discovery, remote
  routing, or credential management.

- This issue does not generate a route with a model or claim that the selected route is globally
  optimal.

- This issue does not make different models statistically equivalent. Reports must identify route,
  capability, price, and availability as experimental confounders.

- This issue does not change policy, credentials, tools, prompts, skills, graph structure, budgets,
  verifiers, or isolation.

- This issue does not route model verifiers, child workflows, or multiple agent nodes.

- This issue does not publish a benchmark superiority claim without measured held-out evidence.

### Failure modes

- **Timeouts** — Candidate admission performs no network call. Evaluation and runtime provider
  deadlines keep their existing bounded behavior and record the affected profile route without
  fallback or retry.

- **Partial failures** — Immutable state and candidate dependencies publish before the effective
  head. Pre-head failure leaves the old head authoritative. Flow reconciles post-boundary
  uncertainty from exact durable state.

- **Invalid input** — Invalid or unstable route candidates fail closed. They publish no durable
  state.

- **Missing context** — Missing state, source, evidence, provider configuration, credentials, or
  policy stops the operation. Flow uses no live fallback.

- **Dependency outage** — Provider unavailability is one profile's bounded trial outcome. Flow does
  not select another model, retry, or reinterpret the failure as verified success.

- **Resource exhaustion** — Existing source, parser, trial, token, cost, time, artifact, and output
  bounds remain. Route strings and tuples have fixed limits.

### Interface contracts

- A route candidate has one versioned identity, workflow id, root agent node id, and baseline
  identity. It also has exact before and after tuples, a manifest identity, and a candidate digest.

- A route tuple contains a bounded provider, bounded model id, and one closed thinking level. It
  contains no credential, endpoint, price, availability, or secret material.

- Effective candidate artifacts add one `model-routing` surface. Their complete baseline and
  candidate states remain self-consistent and differ only at the declared tuple.

- A routing evaluation records one explicit route per paired profile. All non-route controls remain
  shared and exact. Legacy plans retain their existing single shared-model contract and bytes.

- Public candidate, evaluation, activation, run, event, inspection, and export views contain route
  identities and digests. They contain no workflow bodies, absolute filesystem paths, credentials,
  private responses, or private verifier material.

- Activation and rollback use the existing complete effective-state head. They retain its atomic
  transition contract.

## Verification map

| Criteria | Type | Planned command | Passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–3 | Contract and behavioral | `npx vitest run test/unit/adaptation/model-routing-candidate.test.ts test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-candidate.test.ts` | Exact tuple bounds, identity, no-op rejection, one-target projection, and independent immutable-field mutation matrix pass | Dynamic or multi-node routing |
| 1–3, 9 | Filesystem and error | `npx vitest run test/unit/infrastructure/fs/local-model-routing-candidate.test.ts test/unit/infrastructure/fs/local-effective-harness-candidate.test.ts` | Exact and +1 byte bounds, no-follow ancestry, source-race, cancellation, privacy, and stable reopen pass | Remote candidate sources |
| 4–5 | Evaluation contract | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/application/run-evaluation.test.ts` | Legacy plans remain exact. Route pairs bind two explicit routes and reject non-route drift. | Equal capability, price, latency, or availability between models |
| 5, 7–8 | Offline durability | `npx vitest run test/unit/infrastructure/fs/local-evaluation-store.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/cli/evaluation.test.ts` | Live-source drift cannot change durable execution or review. Public canaries stay absent. | Provider execution without configured credentials |
| 6, 9 | Activation and settlement | `npx vitest run test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-effective-harness-store.test.ts` | Exact superior evidence gates activation. State, concurrency, cancellation, and commit-boundary matrices pass. | Distributed multi-host transactions |
| 7–8 | Runtime and public output | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/cli/public-output.test.ts` | Selected state reaches attached, detached, child, recovery, and replay paths without live fallback or private data | Dynamic route changes during a run |
| 10 | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/architecture-documentation.test.ts` | Architecture, evaluation, recovery, testing, roadmap, and README routing remain accurate and linked | External standards certification |
| All | Static and runtime | `npm run format:check && npm run lint && npm run typecheck && npm run build && npm test -- --maxWorkers=1 && npm run test:coverage -- --testTimeout=15000 && npm run test:runtime && npm run pack:check` | Repository quality, complete serial suite, coverage, runtime probes, and packaged CLI checks pass | Live paid-provider benchmark evidence |

## Implementation sequence

1. RED/GREEN the bounded route-candidate source, identity, digest, projection, and mutation matrix.

2. RED/GREEN no-follow local admission with cancellation and source-race settlement.

3. RED/GREEN effective candidate union, state-only projection, content-free views, and storage.

4. RED/GREEN a backward-compatible paired-route evaluation control and exact plan identity.

5. RED/GREEN evaluation execution, reports, offline inspection, export, and adversarial cross-binding.

6. RED/GREEN activation, rollback, runtime snapshots, recovery, replay, concurrency, and privacy.

7. Update public documentation and the architecture diagram.

8. Run focused, full, runtime, documentation, and package gates. Review to zero P1/P2/P3.

## Evidence

### Frozen acceptance map

The exact Issue #127 selector passed 248 tests across 20 files:

```text
npx vitest run test/unit/adaptation/model-routing-candidate.test.ts test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-candidate.test.ts test/unit/infrastructure/fs/local-model-routing-candidate.test.ts test/unit/infrastructure/fs/local-effective-harness-candidate.test.ts test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/application/run-evaluation.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/cli/evaluation.test.ts test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-effective-harness-store.test.ts test/unit/application/run-workflow-capabilities.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/cli/public-output.test.ts test/unit/adaptation/effective-harness-transition.test.ts test/integration/cli/effective-harness-runtime.test.ts test/unit/infrastructure/fs/local-adaptation-candidate.test.ts
```

### Complete suite and coverage

The single-worker complete suite passed 4,408 tests and skipped four platform-gated tests across 320
files:

```text
npm test -- --maxWorkers=1
```

The complete V8 coverage run passed the same 4,408 tests and four skips. The 15-second test timeout
accounts for instrumentation overhead. It does not change a product deadline or assertion:

```text
npm run test:coverage -- --testTimeout=15000
```

Coverage was 84.55% statements, 78.99% branches, 91.23% functions, and 84.68% lines. These values
exceed the configured 75%, 65%, 70%, and 75% thresholds.

### Static, documentation, runtime, and package gates

- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, and
  `git diff --check` passed. Lint retained one unrelated informational note in
  `src/application/external-harness-adapter.ts`.

- `npm run docs:style`, `npm run docs:links`, `npm run docs:ste`, and
  `npx vitest run test/integration/package/architecture-documentation.test.ts` passed. The
  architecture documentation test passed four tests.

- `npm run test:runtime` passed 43 tests and skipped 34 platform-gated tests. Nine runtime files
  passed and 10 platform-gated files skipped.

- `npm run pack:check` verified a clean installation and CLI execution from
  `synaptiai-flow-harness-0.0.0.tgz` with policy digest
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

Hosted Linux x64 and independent review evidence will be recorded after the pull request checks the
frozen branch.

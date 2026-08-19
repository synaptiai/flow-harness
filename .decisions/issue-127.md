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
one existing root workflow agent node. Flow compares the current and candidate routes under equal
non-route controls, then uses the existing effective-state transition protocol for preview, apply,
offline execution, recovery, and rollback.

## Current evidence

- `EffectiveHarnessState` already binds exact workflow bytes, compiled workflow identity, and the
  complete immutable non-policy package closure.

- `EffectiveHarnessCandidateArtifact` currently permits prompt, Agent Skill resource, and Agent
  Skill package surfaces. Its parser proves that only the declared surface differs.

- `EvaluationPlan` version 1 currently has one shared model tuple. Evaluation admission recursively
  requires every agent and model verifier in both workflows to use that tuple.

- The workflow model tuple contains provider, model id, and thinking level. Provider credentials
  are runtime configuration and are not part of workflow or candidate identity.

- Existing activation, rollback, durable run snapshots, detached execution, child execution,
  recovery, replay, inspection, and export use immutable selected state without consulting live
  candidate files.

## User, operator, and system flows

### Review and compose a route candidate

1. The operator selects the current effective harness head as the baseline.
2. The operator supplies one bounded candidate that names an existing root agent node and one exact
   replacement provider, model id, and thinking level.
3. Flow reopens and verifies the candidate source without following links.
4. Flow proves that the declared before tuple matches the exact active state.
5. Flow projects only the declared model tuple and stages one immutable effective candidate.
6. Public output shows content-free state, target, route, and digest identities.

### Paired route evaluation

1. The operator selects the staged baseline and candidate states in one paired plan.
2. Flow binds the exact route for each profile in the admitted plan identity.
3. Flow proves equal tasks, fixtures, seeds, order, budgets, network policy, retries, verifier
   definitions, and every workflow field outside the declared route.
4. Each trial uses its profile's exact route and a fresh workspace.
5. Durable trial and report evidence retains the profile route identity and measured cost, token,
   success, failure, and policy evidence.
6. Offline inspection and export need no live candidate, workflow, catalog, provider configuration,
   or credential source.

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
4. A failure after the commit boundary reopens exact durable state and returns settled or
   commit-uncertain according to the existing transition protocol.

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

The roadmap comparison considered seven ordinal dimensions: product value, fit with existing seams,
authority safety, evaluation readiness, standards fit, implementation simplicity, and leverage for
later work. Scores were design judgments from one to five, not runtime measurements.

| Approach | Value | Seam | Safety | Evaluation | Standards | Simplicity | Leverage |
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
| Static reviewed tuple | Smallest explicit authority; exact paired evidence; composes with current state | One route per candidate; operator supplies the alternative | Selected |
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

- This issue does not add dynamic task classification, model-selected routing, fallback chains,
  load balancing, automatic provider discovery, remote routing services, or credential management.
- This issue does not generate a route with a model or claim that the selected route is globally
  optimal.
- This issue does not make different models statistically equivalent. Reports must identify route,
  capability, price, and availability as experimental confounders.
- This issue does not change policy packages, provider credentials, network authority, tools,
  prompts, skills, packages, graph structure, budgets, retries, verifiers, or runtime isolation.
- This issue does not add routing for model verifiers, packaged model verifiers, child-workflow
  nodes, or multiple agent nodes in one candidate.
- This issue does not publish a benchmark superiority claim without measured held-out evidence.

### Failure modes

- **Timeouts** — Candidate admission performs no network call. Evaluation and runtime provider
  deadlines keep their existing bounded behavior and record the affected profile route without
  fallback or retry.
- **Partial failures** — Immutable state and candidate dependencies publish before the effective
  head. Pre-head failure leaves the old head authoritative; post-boundary uncertainty is reconciled
  from exact durable state.
- **Invalid input** — Malformed, oversized, linked, changing, stale, ambiguous, unsupported, no-op,
  or identity-inconsistent route candidates fail closed with fixed value-free stages and no durable
  mutation.
- **Missing context** — A missing active state, target node, candidate source, evaluation artifact,
  provider configuration, credential, or policy admission fails before execution or activation. No
  live catalog fallback is permitted.
- **Dependency outage** — Provider unavailability is one profile's bounded trial outcome. Flow does
  not select another model, retry, or reinterpret the failure as verified success.
- **Resource exhaustion** — Existing source byte, JSON node/depth, evaluation trial, token, cost,
  execution, artifact, and output bounds remain authoritative. The route candidate adds fixed small
  string and tuple bounds only.

### Interface contracts

- A route candidate has one versioned identity, one workflow id, one root agent node id, one exact
  baseline workflow identity, one exact before tuple, one exact after tuple, one manifest identity,
  and one candidate digest.
- A route tuple contains a bounded provider, bounded model id, and one closed thinking level. It
  contains no credential, endpoint, price, availability, or secret material.
- Effective candidate artifacts add one `model-routing` surface. Their complete baseline and
  candidate states remain self-consistent and differ only at the declared tuple.
- A routing evaluation records one explicit route per paired profile. All non-route controls remain
  shared and exact. Legacy plans retain their existing single shared-model contract and bytes.
- Public candidate, evaluation, activation, run, event, inspection, and export views contain route
  identities and digests but no workflow bodies, candidate paths, credentials, private responses,
  or private verifier material.
- Activation and rollback continue to use the existing complete effective-state head and atomic
  transition contract.

## Verification map

| Criteria | Type | Planned command | Passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–3 | Contract and behavioral | `npx vitest run test/unit/adaptation/model-routing-candidate.test.ts test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-candidate.test.ts` | Exact tuple bounds, identity, no-op rejection, one-target projection, and independent immutable-field mutation matrix pass | Dynamic or multi-node routing |
| 1–3, 9 | Filesystem and error | `npx vitest run test/unit/infrastructure/fs/local-model-routing-candidate.test.ts test/unit/infrastructure/fs/local-effective-harness-candidate.test.ts` | Exact and +1 byte bounds, no-follow ancestry, source-race, cancellation, privacy, and stable reopen pass | Remote candidate sources |
| 4–5 | Evaluation contract | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/application/run-evaluation.test.ts` | Legacy shared-model plans remain exact; routing pairs bind two explicit routes and reject every non-route mismatch | Equal capability, price, latency, or availability between models |
| 5, 7–8 | Offline durability | `npx vitest run test/unit/infrastructure/fs/local-evaluation-store.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/cli/evaluation.test.ts` | Candidate removal and hostile live-source drift cannot change execution, resume, replay, inspect, or export; public canaries stay absent | Provider execution without configured credentials |
| 6, 9 | Activation and settlement | `npx vitest run test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-effective-harness-store.test.ts` | Superior exact evaluation required; preview/apply/rollback compose state; stale, concurrent, cancellation, and commit-boundary matrices pass | Distributed multi-host transactions |
| 7–8 | Runtime and public output | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/cli/public-output.test.ts` | Selected state reaches attached, detached, child, recovery, and replay paths without live fallback or private data | Dynamic route changes during a run |
| 10 | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts` | Architecture, evaluation, sourcing, recovery, testing, roadmap, and README routing remain accurate and linked | External standards certification |
| All | Static and runtime | `npm run format:check && npm run lint && npm run typecheck && npm run build && npm run runtime && npm run test:serial && npm run package:check` | Repository quality, complete serial suite, runtime probes, and packed-package checks pass | Live paid-provider benchmark evidence |

## Implementation sequence

1. RED/GREEN the bounded route-candidate source, identity, digest, projection, and mutation matrix.
2. RED/GREEN no-follow local admission with cancellation and source-race settlement.
3. RED/GREEN effective candidate union, state-only projection, content-free views, and storage.
4. RED/GREEN a backward-compatible paired-route evaluation control and exact plan identity.
5. RED/GREEN evaluation execution, reports, offline inspection, export, and adversarial cross-binding.
6. RED/GREEN activation, rollback, runtime snapshots, recovery, replay, concurrency, and privacy.
7. Update public documentation and the architecture diagram.
8. Run focused, full, runtime, documentation, and package gates; review to zero P1/P2/P3.
